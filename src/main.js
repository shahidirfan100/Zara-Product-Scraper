// Zara Product Scraper - Production-ready with Playwright Firefox
import { PlaywrightCrawler, Dataset } from 'crawlee';
import { Actor, log } from 'apify';
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
// Rotated User-Agents for Firefox (Windows, Mac, Linux)
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

// Extract category ID from URL
const extractCategoryId = (url) => {
    const match = url.match(/[-/]l(\d+)\.html/) || url.match(/category[=/](\d+)/);
    return match ? match[1] : null;
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
    maxRequestRetries: 3,
    useSessionPool: true,
    sessionPoolOptions: {
        maxPoolSize: 5,
        sessionOptions: { maxUsageCount: 3 },
    },
    maxConcurrency: 5,
    requestHandlerTimeoutSecs: 60,
    navigationTimeoutSecs: 30,

    // STRICT PLAYWRIGHT FIREFOX CONFIGURATION
    launchContext: {
        launcher: firefox,
        userAgent: getRandomUserAgent(),
        launchOptions: {
            headless: true,
            // ignoreHTTPSErrors: true  <-- Removed as per skill default
            // firefoxUserPrefs: { ... } <-- Removed custom prefs as per skill default
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
            // Manual stealth scripts REMOVED to avoid modifying navigator on Firefox which can leak.
            // Playwright's firefox launcher manages this better natively.
        },
    ],
    async requestHandler({ page, request, crawler: crawlerInstance }) {
        log.info(`Processing: ${request.url}`);

        // Wait for page to load and establish session
        await page.waitForLoadState('domcontentloaded');
        try {
            await page.waitForTimeout(2000);
        } catch (e) { }

        // Check if page loaded successfully
        const pageTitle = await page.title().catch(() => '');
        if (pageTitle.includes('Access Denied') || pageTitle.includes('Blocked') || pageTitle.includes('403')) {
            log.warning('Page blocked by anti-bot. Session may be flagged.');
            // throw new Error('Blocked') // Optional: throw to retry with new IP
            return;
        }

        log.info('Page loaded successfully. Extracting data...');

        // Strategy 1: Extract from window.__PRELOADED_STATE__ or window.zara
        const preloadedData = await page.evaluate(() => {
            try {
                // Priority 1: __PRELOADED_STATE__ (SSR data)
                if (window.__PRELOADED_STATE__) {
                    return {
                        source: '__PRELOADED_STATE__',
                        data: window.__PRELOADED_STATE__,
                        categoryId: window.__PRELOADED_STATE__.viewPayload?.categoryId
                    };
                }

                // Priority 2: window.zara object
                if (window.zara) {
                    return {
                        source: 'window.zara',
                        data: window.zara,
                        categoryId: window.zara.viewPayload?.category?.id || window.zara.viewPayload?.categoryId
                    };
                }

                return { source: null, data: null };
            } catch (e) {
                return { source: null, data: null, error: e.message };
            }
        });

        let extractedProducts = [];
        let internalCategoryId = preloadedData.categoryId || extractCategoryId(request.url);

        // Extract products from preloaded data
        if (preloadedData.data) {
            log.info(`Found ${preloadedData.source} data source. Category ID: ${internalCategoryId}`);
            const products = extractProductsFromData(preloadedData.data);
            if (products && products.length > 0) {
                extractedProducts = products;
                log.info(`Extracted ${products.length} products from ${preloadedData.source}`);
            }
        }

        // Strategy 2: Fetch via internal API (if available)
        // Use the internal ID if found, otherwise fallback to URL ID (which might be wrong like 1415 vs 2419833)
        if (extractedProducts.length === 0 && internalCategoryId) {
            log.info(`Attempting to fetch via internal API with Category ID: ${internalCategoryId}...`);

            const apiProducts = await page.evaluate(async (catId) => {
                try {
                    // Build API URL
                    const locale = window.location.pathname.split('/').slice(1, 3).join('/');
                    const apiUrl = `https://www.zara.com/${locale}/category/${catId}/products?ajax=true`;

                    // Fetch using browser context (inherits cookies/session)
                    const response = await fetch(apiUrl, {
                        headers: {
                            'accept': 'application/json',
                            'x-requested-with': 'XMLHttpRequest',
                        },
                    });

                    if (!response.ok) {
                        return { error: `API returned ${response.status}`, products: [] };
                    }

                    const data = await response.json();
                    return { products: data.productGroups || data.products || [], data };
                } catch (e) {
                    return { error: e.message, products: [] };
                }
            }, internalCategoryId);

            if (apiProducts.products) {
                // The API usually returns the same nested structure (productGroups), so we use the smart extractor
                const fromApi = extractProductsFromData(apiProducts.products.length ? apiProducts.products : apiProducts.data);
                if (fromApi.length > 0) {
                    log.info(`Fetched ${fromApi.length} products via API`);
                    extractedProducts = fromApi;
                }
            }
        }

        // Strategy 3: Parse from JSON-LD structured data
        if (extractedProducts.length === 0) {
            log.info('Attempting to extract from JSON-LD...');
            const jsonLdProducts = await page.evaluate(() => {
                try {
                    const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
                    for (const script of scripts) {
                        const data = JSON.parse(script.textContent);
                        if (data['@type'] === 'ItemList' && data.itemListElement) {
                            return data.itemListElement;
                        }
                    }
                    return [];
                } catch (e) {
                    return [];
                }
            });

            if (jsonLdProducts && jsonLdProducts.length > 0) {
                const fromLd = normalizeProducts(jsonLdProducts);
                extractedProducts = fromLd;
                log.info(`Extracted ${fromLd.length} products from JSON-LD`);
            }
        }

        if (extractedProducts.length === 0) {
            log.warning('No products found after all extraction attempts');
            return;
        }

        // Process and save products
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

        // Pagination: Load more products if needed
        if (saved < RESULTS_WANTED && extractedProducts.length > 0) {
            log.info('Checking for more products...');

            // ... (keep existing pagination logic) ...
            const hasMore = await page.evaluate(async () => {
                const loadMoreBtn = document.querySelector('[data-qa-action="load-more"], button.load-more, button[class*="show-more"]');
                if (loadMoreBtn && !loadMoreBtn.disabled) {
                    loadMoreBtn.click();
                    return true;
                }
                window.scrollTo(0, document.body.scrollHeight);
                return false;
            });

            if (hasMore) {
                await page.waitForTimeout(2000);
                await crawlerInstance.addRequests([{
                    url: request.url,
                    userData: { attempt: (request.userData?.attempt || 0) + 1 },
                }]);
            }
        }
    },

    failedRequestHandler({ request }, error) {
        log.error(`Request ${request.url} failed: ${error.message}`);
    },
});

// Helper: Extract products from various data structures
function extractProductsFromData(data) {
    if (!data) return [];

    // Direct array check
    if (Array.isArray(data)) {
        // structural check: is this a list of PRODUCTS or GROUPS?
        // If items identify as products, return them.
        if (isProductArray(data)) return normalizeProducts(data);

        // If items are groups (have elements/commercialComponents), flatten them
        const flattened = [];
        for (const item of data) {
            if (item.elements) {
                flattened.push(...extractProductsFromData(item.elements));
            } else if (item.commercialComponents) {
                flattened.push(...extractProductsFromData(item.commercialComponents));
            } else {
                // Maybe it's a mixed array? Check individually
                const p = normalizeProducts([item]);
                if (p.length) flattened.push(...p);
            }
        }
        return flattened;
    }

    // Object: Search known paths
    const searchPaths = [
        'productGroups', // Check groups first as they contain the real data
        'viewPayload.productGroups',
        'grid.products',
        'productList',
        'products',
        'category.products',
    ];

    for (const path of searchPaths) {
        const value = getNestedValue(data, path);
        if (value) {
            log.debug(`Found data at ${path}`);
            const extracted = extractProductsFromData(value);
            if (extracted.length > 0) return extracted;
        }
    }

    return [];
}

// Helper: Get nested object value
function getNestedValue(obj, path) {
    return path.split('.').reduce((acc, part) => acc?.[part], obj);
}

// Helper: Validate if array contains actual products (not media formats)
function isProductArray(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return false;

    const firstItem = arr[0];
    if (!firstItem || typeof firstItem !== 'object') return false;

    // Strong indicator it's NOT a product: has nested elements/components
    if (firstItem.elements || firstItem.commercialComponents) return false;

    // Check if it's a product (must have product-like properties)
    const hasProductProps = firstItem.id || firstItem.productId || firstItem.name || firstItem.detail;

    // Exclude media format arrays (these have type names like "PNG", "MPEG4_ZOOM")
    const isMediaFormat = typeof firstItem === 'string' ||
        (firstItem.id && typeof firstItem.id === 'number' && firstItem.id < 100 && !firstItem.name);

    return hasProductProps && !isMediaFormat;
}

// Helper: Normalize products to consistent format
function normalizeProducts(products) {
    if (!Array.isArray(products)) return [];

    return products.map(item => {
        // Skip invalid items
        if (!item || typeof item !== 'object') return null;

        // Handle different product structures
        const product = item.detail || item.item || item.product || item;

        // Extract product ID - must be a meaningful string
        const productId = String(
            product.id || product.productId ||
            product.seo?.keyword || product.seo?.seoProductId ||
            product.commercialComponents?.[0]?.id || ''
        );

        // Skip if product ID looks like a media format ID (small numbers)
        // Also skip if it identifies as a Category or Group (often has ID but no price/image context here)
        if (!productId || (productId.length < 4 && /^\d+$/.test(productId)) || productId.length > 20) {
            return null;
        }

        // Extract name - must exist
        const name = product.name || product.title ||
            product.seo?.seoProductId || product.seo?.keyword ||
            product.detail?.displayName || '';

        // Skip if no name
        if (!name) return null;

        // Price extraction with multiple fallbacks
        let price = null;
        if (product.price) {
            if (typeof product.price === 'object') {
                price = product.price.value || product.price.amount || product.price.formattedPrice;
            } else {
                price = product.price;
            }
        } else if (product.displayPrice) {
            price = product.displayPrice;
        } else if (product.formattedPrice) {
            price = product.formattedPrice;
        } else if (product.detail?.price) {
            price = product.detail.price;
        }

        // Correct price (sometimes in cents)
        if (typeof price === 'number' && price > 1000 && Number.isInteger(price)) {
            price = price / 100;
        }
        // String price clean up
        if (typeof price === 'string') {
            const match = price.match(/[\d.,]+/);
            if (match) price = parseFloat(match[0].replace(/,/g, ''));
        }

        // Currency
        const currency = product.currency || product.currencyIso ||
            product.detail?.currency || 'GBP';

        // Image URL with multiple fallbacks
        let imageUrl = null;
        if (product.image) {
            imageUrl = typeof product.image === 'string' ? product.image : product.image.url;
        } else if (product.xmedia && Array.isArray(product.xmedia) && product.xmedia.length > 0) {
            // Find actual image (not video format)
            const realImage = product.xmedia.find(m =>
                m.url && !m.mediaType?.includes('VIDEO') && !m.mediaType?.includes('MPEG')
            );
            if (realImage) {
                imageUrl = realImage.url || realImage.path;
            }
        } else if (product.images && Array.isArray(product.images) && product.images.length > 0) {
            imageUrl = product.images[0];
        } else if (product.detail?.xmedia?.[0]) {
            imageUrl = product.detail.xmedia[0].url || product.detail.xmedia[0].path;
        }

        // Fallback for color media
        if (!imageUrl && product.colors && product.colors.length > 0) {
            const c = product.colors[0];
            if (c.xmedia && c.xmedia.length > 0) {
                imageUrl = c.xmedia[0].url || c.xmedia[0].path;
            }
        }

        // Product URL
        let productUrl = product.url || product.detailUrl || product.detail?.url;
        if (!productUrl && product.seo?.keyword) {
            productUrl = `/${product.seo.keyword}.html`;
        } else if (!productUrl && productId) {
            productUrl = `/product/${productId}.html`;
        }

        // Availability
        const availability = product.availability ||
            product.detail?.availability ||
            (product.inStock ? 'in_stock' : 'out_of_stock') ||
            null;

        // Category info
        const category = product.category || product.section ||
            product.detail?.category || null;
        const subcategory = product.subcategory || product.subSection ||
            product.detail?.subcategory || null;

        // Colors
        const colors = product.colors || product.availableColors ||
            product.detail?.colors || null;

        return {
            product_id: productId,
            name: name,
            price: price,
            currency: currency,
            image_url: normalizeImageUrl(imageUrl),
            product_url: productUrl && !productUrl.startsWith('http') ?
                `https://www.zara.com${productUrl}` : productUrl,
            availability: availability,
            category: category,
            subcategory: subcategory,
            colors: colors,
        };
    }).filter(p => p !== null && p.product_id && p.name);
}

await crawler.run([{ url: startUrl }]);
log.info(`Scraping completed. Total products saved: ${saved}`);
await Actor.exit();
