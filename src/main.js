// Zara Product Scraper - Production-ready with Playwright Firefox
import { Actor, log } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';
import { firefox } from 'playwright';

await Actor.init();

const input = (await Actor.getInput()) || {};
const {
    startUrl,
    results_wanted: RESULTS_WANTED_RAW = 20,
    proxyConfiguration: proxyConfig,
} = input;

if (!startUrl) {
    throw new Error('startUrl is required. Please provide a Zara category URL.');
}

const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : 20;

log.info(`Starting Zara scraper for URL: "${startUrl}", results wanted: ${RESULTS_WANTED}`);

// CONFIGURATION
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.7; rv:134.0) Gecko/20100101 Firefox/134.0',
    'Mozilla/5.0 (X11; Linux x86_64; rv:134.0) Gecko/20100101 Firefox/134.0',
];
const getRandomUserAgent = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

// Normalize image URL
const normalizeImageUrl = (url) => {
    if (!url) return null;
    let cleanUrl = url.startsWith('//') ? `https:${url}` : url;
    if (cleanUrl.startsWith('/')) cleanUrl = `https://static.zara.net${cleanUrl}`;
    return cleanUrl.split('?')[0];
};

// Create proxy configuration
const proxyConfiguration = await Actor.createProxyConfiguration(proxyConfig || {
    useApifyProxy: true,
    apifyProxyGroups: ['RESIDENTIAL'],
});

let saved = 0;
const seenIds = new Set();

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxRequestRetries: 2,
    maxConcurrency: 1, // Lower for stealth
    requestHandlerTimeoutSecs: 45,
    navigationTimeoutSecs: 20,

    launchContext: {
        launcher: firefox,
        userAgent: getRandomUserAgent(),
        launchOptions: {
            headless: true,
            ignoreHTTPSErrors: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            firefoxUserPrefs: {
                'geo.enabled': false,
                'media.peerconnection.enabled': false,
                'webgl.disabled': false,
            }
        },
    },

    preNavigationHooks: [
        async ({ page }) => {
            // Aggressive resource blocking for speed
            await page.route('**/*', (route) => {
                const type = route.request().resourceType();
                const url = route.request().url();

                // Block all non-essential resources
                if (['font', 'media', 'stylesheet', 'image'].includes(type) ||
                    url.includes('analytics') ||
                    url.includes('tracking') ||
                    url.includes('gtm') ||
                    url.includes('facebook') ||
                    url.includes('doubleclick') ||
                    url.includes('hotjar')) {
                    return route.abort();
                }
                return route.continue();
            });
        },
    ],

    requestHandler: async ({ page, request, crawler: crawlerInstance }) => {
        log.info(`Processing: ${request.url}`);

        // Quick block check
        const pageTitle = await page.title().catch(() => '');
        if (pageTitle.includes('Access Denied') || pageTitle.includes('Blocked') || pageTitle.includes('403')) {
            throw new Error(`Page blocked by anti-bot (Title: ${pageTitle}) - retrying with new session`);
        }

        log.info('Page loaded successfully. Attempting data extraction...');

        // Step 1: Extract Category details from global state
        const categoryData = await page.evaluate(() => {
            const zData = window.zara;
            if (!zData) return null;

            // Try different paths for category ID
            const payload = zData.viewPayload || {};
            const catId = payload.category?.id ||
                payload.productFilters?.categoryId ||
                zData.appConfig?.categoryId;

            return {
                categoryId: catId,
                cookies: document.cookie,
                locale: window.location.pathname.split('/').slice(1, 3).join('/')
            };
        });

        let extractedProducts = [];
        // Derive locale fallback from request URL if categoryData failed
        const requestLocale = new URL(request.url).pathname.split('/').slice(1, 3).join('/');
        const currentLocale = categoryData?.locale || requestLocale || 'uk/en';

        // Step 2: Extract from initial window.zara payload if available
        if (categoryData) {
            log.info(`Identified Category ID: ${categoryData.categoryId}`);
            const windowProducts = await page.evaluate(() => {
                const payload = window.zara?.viewPayload;
                // Check multiple potential locations
                const products = payload?.products ||
                    payload?.grid?.products ||
                    payload?.productGroups?.[0]?.elements?.[0]?.commercialComponents;
                return products;
            });

            if (windowProducts && Array.isArray(windowProducts) && windowProducts.length > 0) {
                log.info(`Found ${windowProducts.length} products in initial state`);
                const normalized = normalizeProducts(windowProducts, currentLocale);
                extractedProducts.push(...normalized);
            }
        }

        // Step 3: API Fetch (Primary Strategy)
        // FORCE API fetch if we haven't reached the target count, to ensure we get a full list
        if (categoryData?.categoryId && extractedProducts.length < RESULTS_WANTED) {
            log.info(`Fetching via API for Category ${categoryData.categoryId} to ensure complete data...`);

            const apiProducts = await page.evaluate(async ({ categoryId, locale }) => {
                try {
                    const apiUrl = `https://www.zara.com/${locale}/category/${categoryId}/products?ajax=true`;
                    const response = await fetch(apiUrl, {
                        headers: {
                            'accept': 'application/json',
                            'x-requested-with': 'XMLHttpRequest',
                        }
                    });

                    if (!response.ok) return { error: response.status };

                    const data = await response.json();

                    // Parse new API structure
                    // root -> productGroups[] -> elements[] -> commercialComponents[]
                    let products = [];
                    if (data.productGroups) {
                        data.productGroups.forEach(group => {
                            if (group.elements) {
                                group.elements.forEach(el => {
                                    if (el.commercialComponents) {
                                        products.push(...el.commercialComponents);
                                    }
                                });
                            }
                        });
                    }

                    if (products.length === 0 && data.products) {
                        products = data.products;
                    }

                    return { products };
                } catch (e) {
                    return { error: e.message };
                }
            }, categoryData);

            if (apiProducts.products && apiProducts.products.length > 0) {
                log.info(`Fetched ${apiProducts.products.length} products via API`);
                const normalizedApi = normalizeProducts(apiProducts.products, currentLocale);

                // Merge with initial products (avoiding duplicates)
                const productMap = new Map();
                // Add initial products
                extractedProducts.forEach(p => productMap.set(p.product_id, p));
                // Add API products (overwriting initial if same ID, as API usually has more detail)
                normalizedApi.forEach(p => productMap.set(p.product_id, p));

                extractedProducts = Array.from(productMap.values());
            } else if (apiProducts.error) {
                log.warning(`API Fetch failed: ${apiProducts.error}`);
            }
        }

        // Step 4: JSON-LD Fallback
        if (extractedProducts.length === 0) {
            log.info('Checking JSON-LD data...');
            const jsonLdData = await page.evaluate(() => {
                const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
                return scripts.map(s => JSON.parse(s.innerText));
            });

            for (const data of jsonLdData) {
                if (data['@type'] === 'ItemList' && Array.isArray(data.itemListElement)) {
                    const normalizedLd = normalizeProducts(data.itemListElement, currentLocale);
                    log.info(`Found ${normalizedLd.length} products in JSON-LD`);
                    extractedProducts.push(...normalizedLd);
                    break;
                }
            }
        }

        if (extractedProducts.length === 0) {
            log.warning('No products found. Possible blocking or changed layout.');
            return;
        }

        // Save unique products
        const productsToSave = [];
        for (const item of extractedProducts) {
            if (saved >= RESULTS_WANTED) break;
            if (!item.product_id) continue;

            if (!seenIds.has(item.product_id)) {
                seenIds.add(item.product_id);
                productsToSave.push(item);
                saved++;
            }
        }

        if (productsToSave.length > 0) {
            await Dataset.pushData(productsToSave);
            log.info(`Saved ${productsToSave.length} new products. Total: ${saved}/${RESULTS_WANTED}`);
        }
    },

    failedRequestHandler: async ({ request }, error) => {
        log.error(`Request ${request.url} failed: ${error.message}`);
    },
});

await crawler.run([{ url: startUrl }]);
log.info(`Scraping completed. Total products saved: ${saved}`);
await Actor.exit();

// --- HELPERS ---

function normalizeProducts(rawProducts, locale = 'uk/en') {
    if (!Array.isArray(rawProducts)) return [];

    return rawProducts.map(item => {
        try {
            // Fix: Prioritize root item if it has ID/Name (Zara API v2 structure)
            const p = (item.id && (item.name || item.displayName)) ? item : (item.detail || item.item || item);

            // ID: Handle numeric IDs (e.g., 495669917)
            let id = p.id || p.productId || p.reference || '';
            id = String(id).replace(/-I\d+$/, '');

            // Allow IDs that are at least 3 chars
            if (!id || id.length < 3) return null;

            // Name
            const name = p.name || p.displayName || p.title || '';
            if (!name) return null;

            // Price: The API returns price in cents/minor units (e.g. 3599 -> 35.99)
            let price = null;
            if (p.price) {
                const rawPrice = typeof p.price === 'object' ? (p.price.value || p.price.amount) : p.price;
                if (typeof rawPrice === 'number' && Number.isInteger(rawPrice) && rawPrice > 100) {
                    price = rawPrice / 100;
                } else {
                    price = rawPrice;
                }
            } else if (p.displayPrice) {
                const match = String(p.displayPrice).match(/[\d.,]+/);
                if (match) {
                    price = parseFloat(match[0].replace(/,/g, ''));
                }
            }

            // Image
            let imageUrl = null;
            // Check for color-specific media first as it's often the main one
            if (p.colors && p.colors[0]) {
                const media = p.colors[0].pdpMedia || p.colors[0].xmedia?.[0]; // Added xmedia fallback inside color
                if (media) imageUrl = media.url || media.path;
            }

            if (!imageUrl) {
                if (p.xmedia && p.xmedia[0]) {
                    imageUrl = p.xmedia[0].url || p.xmedia[0].path;
                } else if (typeof p.image === 'string') {
                    imageUrl = p.image;
                } else if (p.image && p.image.url) { // Handle object structure
                    imageUrl = p.image.url;
                }
            }

            // Hard check for deeply nested image in detail object
            if (!imageUrl && p.detail?.colors?.[0]?.xmedia?.[0]) {
                imageUrl = p.detail.colors[0].xmedia[0].url || p.detail.colors[0].xmedia[0].path;
            }

            // URL Construction
            let productUrl = null;

            // Prefer seo values
            const slug = p.seo?.keyword || p.keyword || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
            const seoId = p.seo?.seoProductId || p.seoProductId || id;

            // Construct full URL with -p suffix which is standard for Zara
            if (slug && seoId) {
                // Use locale prefix if available
                const prefix = locale ? `/${locale}` : '';
                productUrl = `${prefix}/${slug}-p${seoId}.html`;
            } else if (p.semanticUrl) {
                productUrl = `/${p.semanticUrl}`;
            }

            // Ensure absolute URL
            if (productUrl && !productUrl.startsWith('http')) {
                productUrl = `https://www.zara.com${productUrl}`;
            }

            return {
                product_id: id,
                name: name,
                price: price,
                currency: p.currency || 'GBP',
                image_url: normalizeImageUrl(imageUrl),
                product_url: productUrl,
                reference: p.reference,
                availability: p.availability || (p.inStock ? 'in_stock' : 'out_of_stock')
            };
        } catch (e) {
            return null;
        }
    }).filter(x => x !== null);
}
