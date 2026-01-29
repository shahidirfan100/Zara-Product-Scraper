// Zara Product Scraper - Production-ready with robust extraction
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
            // Block heavy resources to speed up loading
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

            // Stealth
            await page.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
            });
        },
    ],
    async requestHandler({ page, request, crawler: crawlerInstance }) {
        log.info(`Processing: ${request.url}`);

        // Wait for page to fully load
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(2000); // Give extra time for dynamic content

        // Check if page loaded successfully (not blocked)
        const pageTitle = await page.title().catch(() => '');
        if (pageTitle.includes('Access Denied') || pageTitle.includes('Blocked') || pageTitle.includes('403')) {
            log.warning('Page appears to be blocked or access denied');
            return;
        }

        // Retry loop - wait for window.zara.dataLayer to be populated
        let retries = 0;
        const maxRetries = 10;
        let extractedProducts = [];

        while (retries < maxRetries && extractedProducts.length === 0) {
            await page.waitForTimeout(500); // Wait 0.5 second between attempts
            retries++;

            // Extract products from Zara's dataLayer
            const result = await page.evaluate(() => {
                try {
                    // Check if zara object exists
                    if (!window.zara || !window.zara.dataLayer) {
                        return { error: 'window.zara.dataLayer not found yet', products: [], retry: true };
                    }

                    // Extract products from dataLayer
                    let products = null;

                    // Try different possible paths for product data
                    const dataLayer = window.zara.dataLayer;

                    // Path 1: Most common path - products array
                    if (dataLayer.products && Array.isArray(dataLayer.products)) {
                        products = dataLayer.products;
                    }

                    // Path 2: Check for productList
                    if ((!products || products.length === 0) && dataLayer.productList && Array.isArray(dataLayer.productList)) {
                        products = dataLayer.productList;
                    }

                    // Path 3: Check for category.products
                    if ((!products || products.length === 0) && dataLayer.category?.products) {
                        products = dataLayer.category.products;
                    }

                    // Path 4: Check for page.products
                    if ((!products || products.length === 0) && dataLayer.page?.products) {
                        products = dataLayer.page.products;
                    }

                    // Path 5: Search through all properties for product arrays
                    if (!products || products.length === 0) {
                        const searchForProducts = (obj, depth = 0) => {
                            if (depth > 8 || !obj || typeof obj !== 'object') return null;

                            // Check if this is an array with product-like items
                            if (Array.isArray(obj) && obj.length > 0) {
                                const firstItem = obj[0];
                                if (firstItem && (firstItem.id || firstItem.productId || firstItem.seo || firstItem.name)) {
                                    return obj;
                                }
                            }

                            // Recursively search
                            for (const key of Object.keys(obj)) {
                                if (key === 'products' || key === 'productList' || key === 'items') {
                                    if (Array.isArray(obj[key]) && obj[key].length > 0) {
                                        return obj[key];
                                    }
                                }
                                const found = searchForProducts(obj[key], depth + 1);
                                if (found) return found;
                            }
                            return null;
                        };

                        products = searchForProducts(dataLayer);
                    }

                    if (!products || !Array.isArray(products) || products.length === 0) {
                        return { error: 'Products not found in dataLayer', products: [], retry: true };
                    }

                    // Map products to normalized format
                    return {
                        products: products.map(item => {
                            const productId = String(item.id || item.productId || item.seo?.keyword || '');
                            const name = item.name || item.title || item.seo?.seoProductId || '';
                            
                            // Extract price information
                            let price = null;
                            let currency = 'GBP';
                            
                            if (item.price) {
                                price = item.price;
                            } else if (item.displayPrice) {
                                price = item.displayPrice;
                            } else if (item.formattedPrice) {
                                price = item.formattedPrice;
                            }
                            
                            // Extract currency if available
                            if (item.currency) {
                                currency = item.currency;
                            } else if (item.currencyIso) {
                                currency = item.currencyIso;
                            }

                            // Extract image URL
                            let imageUrl = null;
                            if (item.image) {
                                imageUrl = item.image;
                            } else if (item.xmedia && Array.isArray(item.xmedia) && item.xmedia.length > 0) {
                                const firstImage = item.xmedia[0];
                                if (firstImage.url) {
                                    imageUrl = firstImage.url;
                                } else if (firstImage.path) {
                                    imageUrl = firstImage.path;
                                }
                            } else if (item.images && Array.isArray(item.images) && item.images.length > 0) {
                                imageUrl = item.images[0];
                            }

                            // Build product URL
                            let productUrl = null;
                            if (item.url) {
                                productUrl = item.url;
                            } else if (item.seo?.keyword) {
                                productUrl = `/${item.seo.keyword}.html`;
                            } else if (productId) {
                                productUrl = `/product/${productId}.html`;
                            }

                            // Get availability
                            const availability = item.availability || 
                                               (item.inStock ? 'in_stock' : 'out_of_stock') || 
                                               null;

                            return {
                                productId,
                                name,
                                price,
                                currency,
                                imageUrl,
                                productUrl,
                                availability,
                                category: item.category || null,
                                subcategory: item.subcategory || null,
                                colors: item.colors || null,
                            };
                        }),
                        count: products.length,
                    };
                } catch (e) {
                    return { error: e.message, products: [], retry: true };
                }
            });

            if (result.error && result.retry) {
                log.debug(`Attempt ${retries}/${maxRetries}: ${result.error}`);
                continue;
            }

            if (result.products && result.products.length > 0) {
                extractedProducts = result.products;
                log.info(`Found ${result.count || extractedProducts.length} products after ${retries} attempts`);
            }
        }

        if (extractedProducts.length === 0) {
            log.warning(`No products found after ${maxRetries} attempts`);
            return;
        }

        // Process and save products
        const products = [];
        for (const item of extractedProducts) {
            if (!item.productId || !item.name) continue;

            // Build full image URL
            let fullImageUrl = item.imageUrl;
            if (fullImageUrl && !fullImageUrl.startsWith('http')) {
                if (fullImageUrl.startsWith('//')) {
                    fullImageUrl = `https:${fullImageUrl}`;
                } else {
                    fullImageUrl = `https://static.zara.net${fullImageUrl}`;
                }
            }

            // Build full product URL
            let fullProductUrl = item.productUrl;
            if (fullProductUrl && !fullProductUrl.startsWith('http')) {
                const baseUrl = new URL(request.url);
                fullProductUrl = `${baseUrl.origin}${fullProductUrl}`;
            }

            products.push({
                product_id: item.productId,
                name: item.name,
                price: item.price,
                currency: item.currency,
                image_url: normalizeImageUrl(fullImageUrl),
                product_url: fullProductUrl,
                availability: item.availability,
                category: item.category,
                subcategory: item.subcategory,
                colors: item.colors,
            });
        }

        log.info(`Extracted ${products.length} valid products`);

        // Save products
        const newProducts = [];
        for (const product of products) {
            if (saved >= RESULTS_WANTED) break;

            if (!seenIds.has(product.product_id)) {
                seenIds.add(product.product_id);
                newProducts.push(product);
                saved++;
            }
        }

        if (newProducts.length > 0) {
            await Dataset.pushData(newProducts);
            log.info(`Saved ${newProducts.length} new products. Total: ${saved}/${RESULTS_WANTED}`);
        }

        // Check if we need more products and pagination exists
        if (saved < RESULTS_WANTED) {
            log.info('Looking for pagination...');
            
            // Try to find and click "Load more" or next page button
            const nextButtonClicked = await page.evaluate(() => {
                // Look for various "Load more" button selectors
                const selectors = [
                    'button[data-qa-action="load-more"]',
                    'button.load-more',
                    'button[class*="load-more"]',
                    'button[class*="show-more"]',
                    '.pagination .next',
                    'a.next-page',
                ];

                for (const selector of selectors) {
                    const button = document.querySelector(selector);
                    if (button && !button.disabled) {
                        button.click();
                        return true;
                    }
                }
                return false;
            }).catch(() => false);

            if (nextButtonClicked) {
                log.info('Clicked "Load more" button, waiting for new products...');
                await page.waitForTimeout(3000);
                
                // Re-enqueue the same URL to process newly loaded products
                await crawlerInstance.addRequests([{
                    url: request.url,
                    userData: { attempt: (request.userData?.attempt || 0) + 1 },
                }]);
            } else {
                log.info('No pagination button found or products limit reached');
            }
        }
    },

    failedRequestHandler({ request }, error) {
        log.error(`Request ${request.url} failed: ${error.message}`);
    },
});

await crawler.run([{ url: startUrl }]);
log.info(`Scraping completed. Total products saved: ${saved}`);
await Actor.exit();
