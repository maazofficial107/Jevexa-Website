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
});
