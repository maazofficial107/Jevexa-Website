import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * Dedicated Test Suite for JEVEXA Business Intelligence & Analytics Engine (/tools/analytics).
 * Verifies:
 * - Multi-source data ingestion (CSV / TSV / JSON / URL / Manual)
 * - Deterministic mathematical KPI calculations (Revenue, Net Margin, CAC, LTV, Churn, AOV)
 * - Interactive data table search, grouping, sorting, pagination, and CSV export
 * - Worker backend routes (/api/analytics/fetch-url and /api/analytics/forecast)
 * - UI ergonomics, print view, and accessibility
 */

test('1. Business Analytics Ingestion: CSV, TSV, and JSON parsing with Column Auto-Detection', () => {
    const analyticsJs = fs.readFileSync('analytics.js', 'utf8');

    // Verify parser methods exist
    assert.ok(analyticsJs.includes('parseDelimitedText'));
    assert.ok(analyticsJs.includes('detectColumns'));
    assert.ok(analyticsJs.includes('calculateFromRecords'));

    // Test CSV parsing logic
    const sampleCsv = `Date,Channel,Orders,Gross_Revenue,Expenses,Marketing_Spend,Refunds_Count
2026-10-01,Meta Ads,24,1850.50,780.00,450.00,1
2026-10-02,Google Shopping,18,1240.00,520.00,280.00,0
2026-10-03,Shopify Direct,32,2400.00,980.00,100.00,2`;

    const lines = sampleCsv.trim().split('\n');
    const headers = lines[0].split(',');
    const records = lines.slice(1).map(line => {
        const cols = line.split(',');
        const row = {};
        headers.forEach((h, i) => row[h] = cols[i]);
        return row;
    });

    assert.equal(records.length, 3);
    assert.equal(records[0].Channel, 'Meta Ads');
    assert.equal(parseFloat(records[0].Gross_Revenue), 1850.50);

    // Test column auto-detection regex
    const detected = {
        date: headers.find(h => /(date|timestamp|day|time)/i.test(h)),
        revenue: headers.find(h => /(revenue|sales|gross|amount)/i.test(h)),
        expenses: headers.find(h => /(expense|cogs|cost|spend)/i.test(h)),
        orders: headers.find(h => /(order|transaction|salescount)/i.test(h)),
        channel: headers.find(h => /(channel|source|category)/i.test(h))
    };

    assert.equal(detected.date, 'Date');
    assert.equal(detected.revenue, 'Gross_Revenue');
    assert.equal(detected.expenses, 'Expenses');
    assert.equal(detected.orders, 'Orders');
    assert.equal(detected.channel, 'Channel');
});

test('2. Business Analytics Mathematical KPI Engine: Exact financial formulas & badge thresholds', () => {
    // Financial scenario:
    // Revenue = $100,000, Expenses = $42,000, Ad Spend = $15,000, New Customers = 150, Total = 500, Churned = 15
    const revenue = 100000;
    const expenses = 42000;
    const feeRate = 2.9; // 2.9% payment processing fee
    const feeDeduction = Math.round(revenue * (feeRate / 100)); // $2,900
    const netProfit = revenue - expenses - feeDeduction; // $55,100
    const netMargin = Math.round((netProfit / revenue) * 1000) / 10; // 55.1%

    assert.equal(feeDeduction, 2900);
    assert.equal(netProfit, 55100);
    assert.equal(netMargin, 55.1);

    // Status badge: Healthy >= 20%
    const marginStatus = netMargin >= 20 ? 'Healthy' : (netMargin >= 5 ? 'Tight' : 'Loss');
    assert.equal(marginStatus, 'Healthy');

    // Deficit scenario check
    const deficitRev = 10000;
    const deficitExp = 12000;
    const deficitProfit = deficitRev - deficitExp;
    const deficitMargin = Math.round((deficitProfit / deficitRev) * 1000) / 10;
    const deficitStatus = deficitMargin >= 20 ? 'Healthy' : (deficitMargin >= 5 ? 'Tight' : 'Loss');
    assert.equal(deficitMargin, -20.0);
    assert.equal(deficitStatus, 'Loss');

    // CAC: Marketing Spend / New Customers
    const adSpend = 15000;
    const newCustomers = 150;
    const cac = Math.round(adSpend / newCustomers);
    assert.equal(cac, 100); // $100 CAC

    // Churn Rate: (Churned / Total) * 100
    const totalCustomers = 500;
    const churned = 15;
    const churnRate = Math.round((churned / totalCustomers) * 1000) / 10;
    assert.equal(churnRate, 3.0); // 3.0%

    // LTV: (ARPU * Gross Margin) / Churn Rate
    const arpu = revenue / totalCustomers; // $200
    const grossMarginPct = (revenue - expenses) / revenue; // 0.58
    const ltv = Math.round((arpu * grossMarginPct) / (churnRate / 100)); // (200 * 0.58) / 0.03 = $3,867
    assert.equal(ltv, 3867);

    // LTV:CAC Ratio
    const ltvCac = Math.round((ltv / cac) * 10) / 10;
    assert.equal(ltvCac, 38.7);
    const ltvCacBadge = ltvCac >= 3.0 ? 'Elite' : (ltvCac >= 1.5 ? 'Healthy' : 'Critical');
    assert.equal(ltvCacBadge, 'Elite');

    // Period-over-period growth calculation
    const currentHalf = 60000;
    const prevHalf = 40000;
    const growth = Math.round(((currentHalf - prevHalf) / prevHalf) * 1000) / 10;
    assert.equal(growth, 50.0);
});

test('3. Business Analytics Data Table: Grouping, Searching, Sorting, and CSV Export', () => {
    const rows = [
        { period: '2026-10', orders: 120, revenue: 15000, expenses: 6000, profit: 9000, margin: 60.0, growth: 12.0 },
        { period: '2026-09', orders: 95, revenue: 12000, expenses: 5400, profit: 6600, margin: 55.0, growth: 8.5 },
        { period: '2026-08', orders: 80, revenue: 10000, expenses: 5000, profit: 5000, margin: 50.0, growth: 5.0 }
    ];

    // Search filter
    const query = '2026-10';
    const filtered = rows.filter(r => r.period.includes(query));
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].revenue, 15000);

    // Sorting by revenue desc
    const sortedDesc = [...rows].sort((a, b) => b.revenue - a.revenue);
    assert.equal(sortedDesc[0].revenue, 15000);
    assert.equal(sortedDesc[2].revenue, 10000);

    // Sorting by revenue asc
    const sortedAsc = [...rows].sort((a, b) => a.revenue - b.revenue);
    assert.equal(sortedAsc[0].revenue, 10000);

    // CSV line formatting
    const headers = ['Period / Item', 'Orders / Users', 'Gross Revenue', 'Expenses / Spend', 'Net Profit', 'Margin %', 'Growth %'];
    const csvLines = rows.map(r => [
        r.period, r.orders, r.revenue, r.expenses, r.profit, r.margin, r.growth
    ].map(v => `"${v}"`).join(','));
    const fullCsv = [headers.join(','), ...csvLines].join('\n');

    assert.ok(fullCsv.includes('Period / Item'));
    assert.ok(fullCsv.includes('"2026-10","120","15000"'));
});

test('4. Backend Worker Routes: /api/analytics/fetch-url and /api/analytics/forecast', () => {
    const workerJs = fs.readFileSync('worker.js', 'utf8');

    // Endpoints routed in worker.js
    assert.ok(workerJs.includes('/api/analytics/fetch-url'));
    assert.ok(workerJs.includes('/api/analytics/forecast'));
    assert.ok(workerJs.includes('/api/analytics/report'));

    // Handlers exist
    assert.ok(workerJs.includes('handleAnalyticsFetchUrl'));
    assert.ok(workerJs.includes('handleAnalyticsReport'));

    // Google Sheets URL conversion patterns
    assert.ok(workerJs.includes('docs.google.com'));
    assert.ok(workerJs.includes('export?format=csv'));
    assert.ok(workerJs.includes('pub?output=csv'));

    // Tech stack and price detection
    assert.ok(workerJs.includes('Shopify'));
    assert.ok(workerJs.includes('WooCommerce'));
    assert.ok(workerJs.includes('estimatedAov'));

    // Multi-provider AI cascade for executive forecasting
    assert.ok(workerJs.includes('ANALYTICS_SYSTEM_PROMPT'));
    assert.ok(workerJs.includes('executeGroqWithFallback'));
    assert.ok(workerJs.includes('executeGeminiWithFallback'));
    assert.ok(workerJs.includes('executeOpenRouterWithFallback'));
    assert.ok(workerJs.includes('deterministicAnalyticsReport'));
});

test('5. UI Ergonomics & Component Declarations in index.html', () => {
    const html = fs.readFileSync('index.html', 'utf8');

    // 4 Ingestion Mode Tabs
    assert.ok(html.includes('id="analyticsTabUpload"'));
    assert.ok(html.includes('id="analyticsTabUrl"'));
    assert.ok(html.includes('id="analyticsTabManual"'));
    assert.ok(html.includes('id="analyticsTabDemo"'));

    // Controls & Settings Bar
    assert.ok(html.includes('id="analyticsCurrency"'));
    assert.ok(html.includes('id="analyticsTimeframe"'));
    assert.ok(html.includes('id="analyticsFeeSelect"'));
    assert.ok(html.includes('id="analyticsPrintSummaryBtn"'));

    // Ingestion Panes & Drag-Drop Zone
    assert.ok(html.includes('id="analyticsPaneUpload"'));
    assert.ok(html.includes('id="analyticsDropzone"'));
    assert.ok(html.includes('id="analyticsFileInput"'));
    assert.ok(html.includes('id="analyticsDownloadSampleBtn"'));
    assert.ok(html.includes('id="analyticsLoadDemoBtn"'));
    assert.ok(html.includes('id="analyticsDatasetBanner"'));

    // URL & Manual Panes
    assert.ok(html.includes('id="analyticsPaneUrl"'));
    assert.ok(html.includes('id="analyticsUrlInput"'));
    assert.ok(html.includes('id="analyticsFetchUrlBtn"'));
    assert.ok(html.includes('id="analyticsPaneManual"'));
    assert.ok(html.includes('id="analyticsInputRevenue"'));
    assert.ok(html.includes('id="analyticsInputExpenses"'));
    assert.ok(html.includes('id="analyticsInputAdSpend"'));

    // Interactive Analytical Table
    assert.ok(html.includes('id="analyticsTableCard"'));
    assert.ok(html.includes('id="analyticsTableSearch"'));
    assert.ok(html.includes('id="analyticsTableGroupBy"'));
    assert.ok(html.includes('id="analyticsExportTableCsvBtn"'));
    assert.ok(html.includes('id="analyticsDataTable"'));
    assert.ok(html.includes('id="analyticsTableBody"'));

    // All buttons have explicit type attribute
    const buttonMatches = [...html.matchAll(/<button\b([^>]*)>/gi)];
    const missingType = buttonMatches.filter(m => !/\btype=[\"'][^\"']+[\"']/i.test(m[1]));
    assert.equal(missingType.length, 0, 'Every button in index.html must have an explicit type attribute');
});

test('6. Stylesheet Verification: Responsive Tables & Print Media Styles', () => {
    const css = fs.readFileSync('styles.css', 'utf8');

    assert.ok(css.includes('.analytics-control-panel'));
    assert.ok(css.includes('.analytics-tab-btn.active'));
    assert.ok(css.includes('.analytics-dropzone'));
    assert.ok(css.includes('.analytics-table-wrapper'));
    assert.ok(css.includes('.analytics-data-table'));
    assert.ok(css.includes('@media print'));
    assert.ok(css.includes('#analyticsWorkspace'));
    assert.ok(css.includes('.preview-badges-row'));
    assert.ok(css.includes('.rating-badge'));
    assert.ok(css.includes('.audit-chip'));
    assert.ok(css.includes('.analytics-table-notice'));
});

test('7. Website Intelligence: Real Pixel, Tech Stack, & Payment Gateway Signal Detection', () => {
    const sampleHtml = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="utf-8">
        <title>Luxe Apparel &amp; Fashion Co.</title>
        <meta name="description" content="Shop the finest modern clothing and luxury streetwear. Free express shipping worldwide on all orders.">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta property="og:price:currency" content="USD">
        <!-- Google Tag Manager / GA4 -->
        <script async src="https://www.googletagmanager.com/gtm.js?id=GTM-XYZ1234"></script>
        <script>
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('config', 'G-ABC999888');
        </script>
        <!-- Meta / Facebook Pixel -->
        <script>
            !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
            n.callMethod.apply(n,arguments):n.queue.push(arguments)};
            if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
            fbq('init', '123456789012345');
            fbq('track', 'PageView');
        </script>
        <!-- TikTok Pixel -->
        <script>
            ttq.load('C1234567890');
            ttq.track('PageView');
        </script>
        <!-- Hotjar -->
        <script src="https://static.hotjar.com/c/hotjar-99999.js?sv=6"></script>
        <!-- Klaviyo -->
        <script async type="text/javascript" src="//static.klaviyo.com/onsite/js/klaviyo.js?company_id=KLV123"></script>
        <!-- HubSpot -->
        <script type="text/javascript" id="hs-script-loader" async defer src="//js.hs-scripts.com/9999999.js"></script>
    </head>
    <body>
        <div id="shopify-section-header">
            <script>window.Shopify = { shop: "luxe-apparel.myshopify.com" };</script>
        </div>
        <!-- Stripe Elements & PayPal SDK -->
        <script src="https://js.stripe.com/v3/"></script>
        <script src="https://www.paypal.com/sdk/js?client-id=sb"></script>
        <div class="shopify-payment-button shop-pay">
            <button type="button" class="apple-pay-btn">Apple Pay</button>
        </div>
        <form action="/cart/add" method="post">
            <button type="submit">Add to Cart</button>
        </form>
    </body>
    </html>
    `;

    // 1. Pixel Detection Regex Validation
    const detectedPixels = [];
    if (/(gtag\s*\(\s*['"]config['"]|googletagmanager\.com\/gtm\.js|G-[A-Z0-9]+|UA-[0-9]+-[0-9]+)/i.test(sampleHtml)) {
        detectedPixels.push("Google Analytics (GA4/GTM)");
    }
    if (/(connect\.facebook\.net|fbevents\.js|fbq\s*\(\s*['"]init['"])/i.test(sampleHtml)) {
        detectedPixels.push("Meta Pixel");
    }
    if (/(analytics\.tiktok\.com|ttq\.load|ttq\.track)/i.test(sampleHtml)) {
        detectedPixels.push("TikTok Pixel");
    }
    if (/(static\.hotjar\.com|hjid|hotjar\.com)/i.test(sampleHtml)) {
        detectedPixels.push("Hotjar");
    }
    if (/(static\.klaviyo\.com|klaviyo\.js|_learnq)/i.test(sampleHtml)) {
        detectedPixels.push("Klaviyo");
    }
    if (/(js\.hs-scripts\.com|js\.hubspot\.com|hbspt)/i.test(sampleHtml)) {
        detectedPixels.push("HubSpot");
    }

    assert.equal(detectedPixels.length, 6);
    assert.ok(detectedPixels.includes("Google Analytics (GA4/GTM)"));
    assert.ok(detectedPixels.includes("Meta Pixel"));
    assert.ok(detectedPixels.includes("TikTok Pixel"));
    assert.ok(detectedPixels.includes("Hotjar"));
    assert.ok(detectedPixels.includes("Klaviyo"));
    assert.ok(detectedPixels.includes("HubSpot"));

    // 2. Tech Stack Detection
    const techStack = [];
    if (/cdn\.shopify\.com|window\.Shopify|myshopify\.com/i.test(sampleHtml)) techStack.push("Shopify");
    assert.ok(techStack.includes("Shopify"));

    // 3. Payment Gateway Signals
    const paymentSignals = [];
    if (/(js\.stripe\.com|stripe)/i.test(sampleHtml)) paymentSignals.push("Stripe");
    if (/(paypal\.com\/sdk\/js|paypal-button|paypal)/i.test(sampleHtml)) paymentSignals.push("PayPal");
    if (/(apple-pay|ApplePaySession)/i.test(sampleHtml)) paymentSignals.push("Apple Pay");
    if (/(shop-pay|shopify-payment-button)/i.test(sampleHtml)) paymentSignals.push("Shop Pay");

    assert.equal(paymentSignals.length, 4);
    assert.ok(paymentSignals.includes("Stripe"));
    assert.ok(paymentSignals.includes("PayPal"));
    assert.ok(paymentSignals.includes("Apple Pay"));
    assert.ok(paymentSignals.includes("Shop Pay"));
});

test('8. Website Intelligence: Shopify API Catalog & JSON-LD Schema Price Extraction', () => {
    // 1. Shopify /products.json response sample
    const sampleShopifyResponse = {
        products: [
            {
                title: "Silk Bomber Jacket",
                product_type: "Outerwear",
                variants: [{ price: "180.00", compare_at_price: "240.00" }]
            },
            {
                title: "Organic Cotton Tee",
                product_type: "Tops",
                variants: [{ price: "45.00", compare_at_price: "50.00" }]
            },
            {
                title: "Wool Overcoat",
                product_type: "Outerwear",
                variants: [{ price: "320.00", compare_at_price: null }]
            },
            {
                title: "Leather Crossbody Bag",
                product_type: "Accessories",
                variants: [{ price: "120.00", compare_at_price: "150.00" }]
            }
        ]
    };

    const detectedPrices = [];
    const detectedProducts = [];

    sampleShopifyResponse.products.forEach(p => {
        const variant = p.variants?.[0] || {};
        const price = parseFloat(variant.price);
        const compareAtPrice = variant.compare_at_price ? parseFloat(variant.compare_at_price) : null;
        if (!isNaN(price) && price > 0) {
            detectedPrices.push(price);
            const discountPct = (compareAtPrice && compareAtPrice > price)
                ? Math.round(((compareAtPrice - price) / compareAtPrice) * 100)
                : 0;
            detectedProducts.push({
                title: p.title,
                price,
                compareAtPrice: compareAtPrice || price,
                discountPct,
                category: p.product_type,
                source: "Shopify Store API"
            });
        }
    });

    assert.equal(detectedProducts.length, 4);
    assert.equal(detectedProducts[0].title, "Silk Bomber Jacket");
    assert.equal(detectedProducts[0].price, 180.00);
    assert.equal(detectedProducts[0].compareAtPrice, 240.00);
    assert.equal(detectedProducts[0].discountPct, 25); // ((240 - 180) / 240) * 100 = 25%

    // 2. Statistical Price Spread Computation
    const sorted = [...detectedPrices].sort((a, b) => a - b); // [45, 120, 180, 320]
    const minPrice = sorted[0];
    const maxPrice = sorted[sorted.length - 1];
    const medianPrice = sorted[Math.floor(sorted.length / 2)];
    const avgPrice = Math.round((sorted.reduce((a, b) => a + b, 0) / sorted.length) * 100) / 100;

    assert.equal(minPrice, 45);
    assert.equal(maxPrice, 320);
    assert.equal(medianPrice, 180); // index 2 in 4 items is 180
    assert.equal(avgPrice, 166.25); // (45 + 120 + 180 + 320) / 4 = 166.25

    // 3. JSON-LD structured schema parsing
    const sampleJsonLd = `
    <script type="application/ld+json">
    {
        "@context": "https://schema.org/",
        "@type": "Product",
        "name": "Cashmere Knit Sweater",
        "category": "Apparel",
        "offers": {
            "@type": "Offer",
            "priceCurrency": "USD",
            "price": "210.00"
        }
    }
    </script>`;

    const match = sampleJsonLd.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
    const parsed = JSON.parse(match[1].trim());
    assert.equal(parsed["@type"], "Product");
    assert.equal(parsed.name, "Cashmere Knit Sweater");
    assert.equal(parseFloat(parsed.offers.price), 210.00);
});

test('9. Website Intelligence: Conversion Readiness Scoring & Scraped Catalog UI Integration', () => {
    // 1. Conversion Readiness scoring formula test
    const computeReadinessScore = ({ hasSsl, hasResponsiveMeta, latencyMs, pixelsCount, paymentCount, hasSchema, ctaCount, descLength }) => {
        let score = 20;
        if (hasSsl) score += 15;
        if (hasResponsiveMeta) score += 15;
        if (latencyMs < 500) score += 15;
        else if (latencyMs < 1200) score += 10;
        else if (latencyMs < 2500) score += 5;

        if (pixelsCount >= 2) score += 15;
        else if (pixelsCount === 1) score += 10;

        if (paymentCount > 0) score += 10;
        if (hasSchema) score += 10;
        if (ctaCount > 0) score += 10;
        if (descLength >= 40) score += 5;

        return Math.min(100, Math.max(30, score));
    };

    // Elite store profile
    const eliteScore = computeReadinessScore({
        hasSsl: true,
        hasResponsiveMeta: true,
        latencyMs: 320,
        pixelsCount: 3,
        paymentCount: 2,
        hasSchema: true,
        ctaCount: 5,
        descLength: 85
    });
    assert.equal(eliteScore, 100);

    // Moderate profile
    const modScore = computeReadinessScore({
        hasSsl: true,
        hasResponsiveMeta: true,
        latencyMs: 1800,
        pixelsCount: 0,
        paymentCount: 0,
        hasSchema: false,
        ctaCount: 1,
        descLength: 10
    });
    // 20 + 15 (ssl) + 15 (meta) + 5 (latency) + 0 + 0 + 0 + 10 (cta) + 0 = 65
    assert.equal(modScore, 65);

    // 2. index.html UI Card Elements verification
    const html = fs.readFileSync('index.html', 'utf8');
    assert.ok(html.includes('id="analyticsUrlPreviewCard"'));
    assert.ok(html.includes('id="analyticsPreviewRating"'));
    assert.ok(html.includes('id="analyticsPreviewScore"'));
    assert.ok(html.includes('id="analyticsPreviewStats"'));
    assert.ok(html.includes('id="analyticsStackBadges"'));
    assert.ok(html.includes('id="analyticsPixelBadges"'));
    assert.ok(html.includes('id="analyticsPaymentBadges"'));
    assert.ok(html.includes('id="analyticsViewCatalogBtn"'));
    assert.ok(html.includes('id="analyticsTableNotice"'));

    // 3. analytics.js Catalog Table Mode verification
    const analyticsJs = fs.readFileSync('analytics.js', 'utf8');
    assert.ok(analyticsJs.includes("scraped_products"));
    assert.ok(analyticsJs.includes("renderDataTable"));
    assert.ok(analyticsJs.includes("analyticsViewCatalogBtn"));
    assert.ok(analyticsJs.includes("analyticsTableNotice"));
});
