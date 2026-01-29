// Zara Product Scraper - Production-ready with hybrid browser API approach
//
// STRATEGY: Multi-layered extraction with fallbacks
// ==========================================
// 1. SSR/Hydration Data: Extract from window.__PRELOADED_STATE__ or window.zara
//    - Fastest method, data is already loaded in page
//    - Works immediately on page load
//
// 2. Internal API Fetching: Use browser context to call Zara's internal APIs
//    - Fetches JSON directly via page.evaluate(fetch())
//    - Inherits valid browser session/cookies (bypasses bot detection)
//    - URL: https://www.zara.com/{locale}/category/{categoryId}/products?ajax=true
//
// 3. JSON-LD Structured Data: Extract from <script type="application/ld+json">
//    - SEO-friendly structured data
//    - Limited product details but always present
//
// Anti-Bot Bypass:
// - Uses browser fingerprinting (Playwright)
// - Residential proxies
// - Enhanced stealth (navigator.webdriver, plugins, languages)
// - Resource blocking for speed
//
// Performance Optimizations:
// - Concurrency: 5 parallel requests
// - Fast timeouts: 60s request, 30s navigation
// - 3 retries maximum
// - Session pooling
//
import { PlaywrightCrawler, Dataset } from 'crawlee';
import { Actor, log } from 'apify';

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
    browserPoolOptions: {
        useFingerprints: true,
        fingerprintOptions: {
            fingerprintGeneratorOptions: {
                browsers: ['chrome'],
                operatingSystems: ['windows'],
                devices: ['desktop'],
            },
        },
    },
    preNavigationHooks: [
        async ({ page }) => {
            // Block heavy resources for faster loading
            await page.route('**/*', (route) => {
                const type = route.request().resourceType();
                const url = route.request().url();

                if (['font', 'media'].includes(type) ||
                    url.includes('google-analytics') ||
                    url.includes('googletagmanager') ||
                    url.includes('facebook') ||
                    url.includes('doubleclick') ||
                    url.includes('hotjar')) {
                    return route.abort();
                }
                return route.continue();
            });

            // Enhanced stealth
            await page.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
                Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
                Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            });
        },
    ],
    async requestHandler({ page, request, crawler: crawlerInstance }) {
        log.info(`Processing: ${request.url}`);

        // Wait for page to load and establish session
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(2000);

        // Check if page loaded successfully
        const pageTitle = await page.title().catch(() => '');
        if (pageTitle.includes('Access Denied') || pageTitle.includes('Blocked') || pageTitle.includes('403')) {
            log.warning('Page blocked by anti-bot. Session may be flagged.');
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
                    };
                }

                // Priority 2: window.zara object
                if (window.zara) {
                    return {
                        source: 'window.zara',
                        data: window.zara,
                    };
                }

                return { source: null, data: null };
            } catch (e) {
                return { source: null, data: null, error: e.message };
            }
        });

        let extractedProducts = [];

        // Extract products from preloaded data
        if (preloadedData.data) {
            log.info(`Found ${preloadedData.source} data source`);
            
            // Debug: Log available keys
            const topLevelKeys = Object.keys(preloadedData.data).slice(0, 10);
            log.debug(`Top-level keys: ${topLevelKeys.join(', ')}`);
            
            const products = extractProductsFromData(preloadedData.data);
            if (products && products.length > 0) {
                extractedProducts = products;
                log.info(`Extracted ${products.length} products from ${preloadedData.source}`);
            } else {
                log.warning(`No valid products found in ${preloadedData.source}`);
            }
        }

        // Strategy 2: Fetch via internal API (if available)
        if (extractedProducts.length === 0) {
            log.info('Attempting to fetch via internal API...');
            
            const categoryId = extractCategoryId(request.url);
            if (categoryId) {
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
                }, categoryId);

                if (apiProducts.products && apiProducts.products.length > 0) {
                    extractedProducts = normalizeProducts(apiProducts.products);
                    log.info(`Fetched ${extractedProducts.length} products via API`);
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
                extractedProducts = normalizeProducts(jsonLdProducts);
                log.info(`Extracted ${extractedProducts.length} products from JSON-LD`);
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
            
            const hasMore = await page.evaluate(async () => {
                // Try to trigger "load more" or scroll
                const loadMoreBtn = document.querySelector('[data-qa-action="load-more"], button.load-more, button[class*="show-more"]');
                if (loadMoreBtn && !loadMoreBtn.disabled) {
                    loadMoreBtn.click();
                    return true;
                }
                
                // Try scrolling to trigger lazy load
                window.scrollTo(0, document.body.scrollHeight);
                return false;
            });

            if (hasMore) {
                await page.waitForTimeout(2000);
                // Re-enqueue to get newly loaded products
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
    const searchPaths = [
        'productList',
        'products',
        'productGroups',
        'category.products',
        'category.productIds',
        'data.products',
        'data.productList',
    ];

    for (const path of searchPaths) {
        const products = getNestedValue(data, path);
        if (products && isProductArray(products)) {
            log.info(`Found products at path: ${path}`);
            return normalizeProducts(products);
        }
    }

    // Deep search with better validation
    const found = deepSearch(data, (obj) => isProductArray(obj));
    
    if (found) {
        log.info(`Found products via deep search`);
        return normalizeProducts(found);
    }
    
    return [];
}

// Helper: Get nested object value
function getNestedValue(obj, path) {
    return path.split('.').reduce((acc, part) => acc?.[part], obj);
}

// Helper: Deep search for product arrays
function deepSearch(obj, testFn, depth = 0, maxDepth = 10) {
    if (depth > maxDepth || !obj || typeof obj !== 'object') return null;
    
    if (testFn(obj)) return obj;
    
    for (const key of Object.keys(obj)) {
        const result = deepSearch(obj[key], testFn, depth + 1, maxDepth);
        if (result) return result;
    }
    
    return null;
}

// Helper: Validate if array contains actual products (not media formats)
function isProductArray(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return false;
    
    const firstItem = arr[0];
    if (!firstItem || typeof firstItem !== 'object') return false;
    
    // Check if it's a product (must have product-like properties)
    const hasProductProps = firstItem.id || firstItem.productId || firstItem.name || 
                           firstItem.commercialComponents || firstItem.detail;
    
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
        if (!productId || (productId.length < 4 && /^\d+$/.test(productId))) {
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
