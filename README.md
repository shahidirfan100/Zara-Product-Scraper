# Zara Product Scraper

Extract comprehensive product data from Zara's fashion collections with ease. Collect product details including prices, names, images, and availability from Zara's category pages. Perfect for fashion research, trend analysis, and retail intelligence.

## Features

- **Category Scraping** — Extract products from any Zara category page
- **Complete Product Data** — Get names, prices, images, and availability status
- **Fashion Intelligence** — Track Zara's latest collections and trends
- **High-Quality Images** — Access full-resolution product photos
- **Availability Tracking** — Monitor stock status across products
- **Color Variants** — Capture available color options for each item
- **Category Organization** — Maintain product categorization structure

## Use Cases

### Fashion Trend Research
Analyze Zara's latest collections and identify emerging fashion trends. Track seasonal releases and style directions across men's and women's fashion.

### Retail Intelligence
Monitor Zara's pricing strategies and product availability. Compare offerings across different categories and track inventory changes.

### Competitive Analysis
Benchmark Zara's product assortment against other fashion retailers. Understand pricing patterns and collection strategies.

### Content Creation
Build fashion inspiration databases with high-quality product images. Create lookbooks and style guides based on current Zara offerings.

### Market Research
Study fashion market dynamics through Zara's product catalog. Analyze category distribution and identify popular product types.

---

## Input Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `startUrl` | String | Yes | — | Zara category URL to scrape products from |
| `results_wanted` | Integer | No | `20` | Maximum number of products to collect |
| `proxyConfiguration` | Object | No | Residential | Proxy settings for reliable scraping |

---

## Output Data

Each item in the dataset contains:

| Field | Type | Description |
|-------|------|-------------|
| `product_id` | String | Unique Zara product identifier |
| `name` | String | Full product name and description |
| `price` | String | Current price with currency |
| `currency` | String | Currency code (GBP, USD, EUR, etc.) |
| `image_url` | String | High-resolution product image URL |
| `product_url` | String | Direct link to product detail page |
| `availability` | String | Stock status (in_stock, out_of_stock, etc.) |
| `category` | String | Product category classification |
| `subcategory` | String | Product subcategory |
| `colors` | Array | Available color options |

---

## Usage Examples

### Men's Fashion Collection

Extract products from Zara's men's all products page:

```json
{
    "startUrl": "https://www.zara.com/uk/en/man-all-products-l7465.html",
    "results_wanted": 100
}
```

### Women's New In Collection

Scrape Zara's women's new arrivals:

```json
{
    "startUrl": "https://www.zara.com/uk/en/woman-new-in-l1056.html",
    "results_wanted": 50
}
```

### Limited Collection

Focus on special or limited edition items:

```json
{
    "startUrl": "https://www.zara.com/uk/en/limited-edition-l1059.html",
    "results_wanted": 25
}
```

---

## Sample Output

```json
{
    "product_id": "123456789",
    "name": "Oversized Cotton Shirt",
    "price": "£39.99",
    "currency": "GBP",
    "image_url": "https://static.zara.net/photos///2024/I/0/1/p/1234/567/800/2/w/750/1234567800_1_1_1.jpg",
    "product_url": "https://www.zara.com/uk/en/oversized-cotton-shirt-p012345678.html",
    "availability": "in_stock",
    "category": "Shirts",
    "subcategory": "Long Sleeve",
    "colors": ["White", "Black", "Navy"]
}
```

---

## Tips for Best Results

### Choose Active Category URLs
- Use current Zara category pages that are actively updated
- Start with main collection pages for comprehensive results
- Verify URLs are accessible before running large scrapes

### Optimize Collection Size
- Begin with smaller batches (20-50 products) for testing
- Scale up based on your data needs and processing capacity
- Balance between comprehensive data and processing time

### Monitor Fashion Seasons
- Run scrapes during new collection launches for trend data
- Schedule regular runs to track seasonal changes
- Focus on specific categories for targeted fashion research

### Proxy Configuration

For reliable results, residential proxies are recommended:

```json
{
    "proxyConfiguration": {
        "useApifyProxy": true,
        "apifyProxyGroups": ["RESIDENTIAL"]
    }
}
```

---

## Integrations

Connect your Zara product data with:

- **Google Sheets** — Export for fashion trend analysis
- **Airtable** — Build product catalog databases
- **Slack** — Get notifications for new arrivals
- **Webhooks** — Send data to custom fashion applications
- **Make** — Create automated fashion workflows
- **Zapier** — Trigger actions based on product updates

### Export Formats

Download data in multiple formats:

- **JSON** — For developers and fashion APIs
- **CSV** — For spreadsheet analysis
- **Excel** — For retail reporting
- **XML** — For e-commerce integrations

---

## Frequently Asked Questions

### How many products can I collect?
You can collect all available products from a Zara category page. The practical limit depends on the category size and your desired result count.

### Can I scrape multiple categories?
Yes, run separate scrapes for different category URLs to build comprehensive fashion datasets across Zara's collections.

### What if some products are out of stock?
The scraper captures current availability status. Out-of-stock items are still included with their availability marked accordingly.

### How often should I run scrapes?
For fashion trend monitoring, run weekly or bi-weekly. For inventory tracking, daily runs may be appropriate depending on your needs.

### Can I get product reviews or ratings?
This scraper focuses on product catalog data. For reviews and ratings, consider dedicated review scraping solutions.

### Are images included?
Yes, high-resolution product images are captured and included in the output data for visual fashion analysis.

---

## Support

For issues or feature requests, contact support through the Apify Console.

### Resources

- [Apify Documentation](https://docs.apify.com/)
- [API Reference](https://docs.apify.com/api/v2)
- [Scheduling Runs](https://docs.apify.com/schedules)

---

## Legal Notice

This actor is designed for legitimate data collection purposes. Users are responsible for ensuring compliance with Zara's terms of service and applicable laws. Use data responsibly and respect rate limits.
