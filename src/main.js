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
    maxConcurrency: 5,
    requestHandlerTimeoutSecs: 60,
    navigationTimeoutSecs: 30,
    
    launchContext: {
        launcher: firefox,
        userAgent: getRandomUserAgent(),
        launchOptions: {
            headless: true,
            ignoreHTTPSErrors: true,
        },
    },

    preNavigationHooks: [
        async ({ page }) => {
            // Block heavy resources for faster loading
            await page.route('**/*', (route) => {
                const type = route.request().resourceType();
                const url = route.request().url();

                if (['font', 'media', 'stylesheet'].includes(type) ||
                    url.includes('google-analytics') ||
                    url.includes('googletagmanager') ||
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

        // Wait for page to load
        try {
            await page.waitForLoadState('domcontentloaded');
        } catch (e) {
            log.warning(`Navigation timeout or error: ${e.message}`);
        }

        // Check for blocks
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
                extractedProducts = normalizeProducts(windowProducts);
            }
        }

        // Step 3: API Fetch (Primary Strategy if initial state empty)
        if (extractedProducts.length === 0 && categoryData?.categoryId) {
            log.info(`Fetching via API for Category ${categoryData.categoryId}...`);
            
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
                extractedProducts = normalizeProducts(apiProducts.products);
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
                    extractedProducts = normalizeProducts(data.itemListElement);
                    log.info(`Found ${extractedProducts.length} products in JSON-LD`);
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

        // Pagination if needed (via API only for speed)
        // Note: For simplicity in this specialized fix, we trust the API returned all items 
        // or we handle pagination by adding a 'page' parameter if supported, 
        // but Zara's 'ajax=true' usually returns the full category or we need to scroll.
        // For now, let's rely on the main batch.
    },

    failedRequestHandler: async ({ request }, error) => {
        log.error(`Request ${request.url} failed: ${error.message}`);
    },
});

await crawler.run([{ url: startUrl }]);
log.info(`Scraping completed. Total products saved: ${saved}`);
await Actor.exit();

// --- HELPERS ---

function normalizeProducts(rawProducts) {
    if (!Array.isArray(rawProducts)) return [];

    return rawProducts.map(item => {
        try {
            // Handle different nesting (commercialComponents often have 'detail' or are direct)
            const p = item.detail || item.item || item;

            // ID
            const id = String(p.id || p.productId || p.reference || '').replace(/-I\d+$/, '');
            if (!id || id.length < 4) return null;

            // Name
            const name = p.name || p.displayName || p.title || '';
            if (!name) return null;

            // Price
            let price = null;
            if (p.price) {
                price = typeof p.price === 'object' ? (p.price.value || p.price.amount) : p.price;
            } else if (p.displayPrice) {
                price = p.displayPrice; // "£ 29.99"
            }

            // Image
            let imageUrl = null;
            if (p.xmedia && p.xmedia[0]) {
                imageUrl = p.xmedia[0].url || p.xmedia[0].path;
            } else if (p.colors && p.colors[0] && p.colors[0].xmedia && p.colors[0].xmedia[0]) {
                imageUrl = p.colors[0].xmedia[0].url || p.colors[0].xmedia[0].path;
            } else if (typeof p.image === 'string') {
                imageUrl = p.image;
            }

            // URL
            let productUrl = p.seo?.keyword ? `/${p.seo.keyword}.html` : null;
            if (!productUrl && p.semanticUrl) productUrl = `/${p.semanticUrl}`;
            
            return {
                product_id: id,
                name: name,
                price: price,
                currency: p.currency || 'GBP',
                image_url: normalizeImageUrl(imageUrl),
                product_url: productUrl ? `https://www.zara.com${productUrl}` : null,
                reference: p.reference,
                availability: p.availability || (p.inStock ? 'in_stock' : 'out_of_stock')
            };
        } catch (e) {
            return null;
        }
    }).filter(x => x !== null);
}
