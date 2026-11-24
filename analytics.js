/**
 * JEVEXA AI Studio - Business Analytics Workspace Controller
 * Handles real-time KPI metrics calculation, interactive responsive SVG charts,
 * AI executive forecasting reports (30/60/90 days), and CSV/JSON export.
 */
(() => {
    'use strict';

    const bindSafe = (target, type, handler, options) => {
        if (!target) return;
        if (window.JEVEXA_SAFE_INTERACTION?.bind) {
            window.JEVEXA_SAFE_INTERACTION.bind(target, type, handler, options);
        } else {
            target.addEventListener(type, handler, options?.listenerOptions);
        }
    };

    function generateUuid() {
        if (typeof window.crypto?.randomUUID === 'function') {
            try { return window.crypto.randomUUID(); } catch (_) {}
        }
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = (Math.random() * 16) | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    function downloadFile(filename, content, mimeType = 'text/plain;charset=utf-8;') {
        const blob = new Blob([content], { type: mimeType });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(link.href), 1500);
    }

    const PRESETS = {
        saas_50k: {
            name: "B2B SaaS Growth ($50k MRR)",
            businessType: "saas",
            baseMetrics: {
                mrr: 48500,
                expensesRatio: 0.42,
                customers: 340,
                cac: 240,
                ltv: 1850,
                churn: 2.1,
                growth: 14.5
            },
            strengths: [
                "Exceptional unit economics with 7.7x LTV/CAC ratio exceeding the 3.0x industry benchmark",
                "Strong gross margin (58%+) providing sufficient cash flow for customer acquisition reinvestment",
                "Low logo churn at 2.1% indicating strong product-market fit and recurring software retention"
            ],
            risks: [
                "Sales cycle lengthens for enterprise prospects with custom data security requirements",
                "Top-of-funnel relies heavily on organic inbound; paid acquisition efficiency requires continuous testing"
            ],
            actions: [
                "Deploy automated lead scoring & outreach sequences to convert high-intent inbound visitors within 15 minutes",
                "Introduce annual prepaid contracts with a 20% discount to accelerate upfront non-dilutive working capital",
                "Implement proactive customer health scoring in CRM to prevent churn before renewal cycles"
            ]
        },
        ecommerce_120k: {
            name: "E-Commerce Brand ($120k GMV)",
            businessType: "ecommerce",
            baseMetrics: {
                mrr: 120000,
                expensesRatio: 0.68,
                customers: 2850,
                cac: 38,
                ltv: 126,
                churn: 4.8,
                growth: 18.2
            },
            strengths: [
                "High transaction volume with 2,850 active monthly purchasing customers",
                "Strong blended customer acquisition cost ($38) relative to $126 90-day repeat LTV",
                "MoM growth tracking at 18.2% driven by multi-channel digital campaigns"
            ],
            risks: [
                "Inventory replenishment lead times can constrain fulfillment during peak seasonal promotional weeks",
                "Ad platform CPM volatility can compress net operating margins below 30%"
            ],
            actions: [
                "Deploy automated cart abandonment and post-purchase upsell email sequences",
                "Bundle high-margin accessory SKUs to lift Average Order Value (AOV) by 18%",
                "Optimize inventory reorder trigger points to maintain continuous fulfillment velocity"
            ]
        },
        agency_35k: {
            name: "Digital Agency ($35k/mo)",
            businessType: "agency",
            baseMetrics: {
                mrr: 35000,
                expensesRatio: 0.40,
                customers: 14,
                cac: 1200,
                ltv: 12500,
                churn: 1.2,
                growth: 8.5
            },
            strengths: [
                "Elite customer lifetime value ($12,500) yielding a 10.4x LTV/CAC ratio",
                "Industry-leading client retention with monthly churn contained at 1.2%",
                "Lean operational model generating healthy 60% net profit margins"
            ],
            risks: [
                "Revenue concentration in top 3 client accounts represents potential vulnerability",
                "Service delivery capacity requires systematized delegation to scale beyond 20 accounts"
            ],
            actions: [
                "Productize bespoke AI automation consulting into standardized tiered monthly retainers",
                "Institute a structured client referral incentive program to drive warm inbound deals",
                "Implement client-facing workflow dashboards to demonstrate continuous weekly ROI"
            ]
        }
    };

    function calculateMetrics(presetKey, timeframe) {
        const preset = PRESETS[presetKey] || PRESETS.saas_50k;
        const b = preset.baseMetrics;
        const mrr = b.mrr;
        const arr = mrr * 12;

        let multiplier = 3;
        let tfLabel = 'Last 90 Days';
        if (timeframe === '30d') {
            multiplier = 1;
            tfLabel = 'Last 30 Days';
        } else if (timeframe === '1y') {
            multiplier = 12;
            tfLabel = 'Trailing 12 Months';
        }

        const revenue = mrr * multiplier;
        const expenses = Math.round(revenue * b.expensesRatio);
        const netProfit = revenue - expenses;
        const netMargin = Math.round((netProfit / (revenue || 1)) * 1000) / 10;
        const ltvCac = Math.round((b.ltv / (b.cac || 1)) * 10) / 10;

        const conservative = Math.round(revenue * 1.06);
        const expected = Math.round(revenue * 1.15);
        const aggressive = Math.round(revenue * 1.25);

        const kpis = {
            mrr,
            arr,
            revenue,
            expenses,
            net_profit: netProfit,
            net_margin: netMargin,
            customers: b.customers,
            cac: b.cac,
            ltv: b.ltv,
            ltv_cac_ratio: ltvCac,
            churn_rate: b.churn,
            mom_growth: b.growth,
            timeframe: tfLabel
        };

        const report = {
            health_score: ltvCac >= 5 ? 92 : (ltvCac >= 3 ? 87 : 78),
            executive_summary: `Your ${preset.businessType.toUpperCase()} operation demonstrates strong unit economics with an LTV/CAC ratio of ${ltvCac}x and a healthy ${netMargin}% net profit margin over ${tfLabel.toLowerCase()}. Revenue momentum is positive with MoM growth tracking at ${b.growth}%.`,
            top_strengths: preset.strengths,
            top_risks: preset.risks,
            forecast: {
                conservative,
                expected,
                aggressive
            },
            strategic_actions: preset.actions
        };

        return { kpis, report };
    }

    const state = {
        kpis: null,
        report: null,
        isAnalyzing: false,
        activePreset: 'saas_50k',
        activeTimeframe: '90d'
    };

    // DOM Elements
    const workspace = document.getElementById('analyticsWorkspace');
    const backBtn = document.getElementById('analyticsBackToStudio');
    const closeBtn = document.getElementById('analyticsWorkspaceClose');

    const presetSelect = document.getElementById('analyticsPresetSelect');
    const timeframeSelect = document.getElementById('analyticsTimeframe');
    const generateBtn = document.getElementById('analyticsGenerateBtn');
    const statusEl = document.getElementById('analyticsStatus');

    // KPI Card Elements
    const metricMrr = document.getElementById('analyticsMetricMrr');
    const metricArr = document.getElementById('analyticsMetricArr');
    const metricRevenue = document.getElementById('analyticsMetricRevenue');
    const metricMargin = document.getElementById('analyticsMetricMargin');
    const metricCac = document.getElementById('analyticsMetricCac');
    const metricLtv = document.getElementById('analyticsMetricLtv');
    const metricLtvCac = document.getElementById('analyticsMetricLtvCac');
    const metricChurn = document.getElementById('analyticsMetricChurn');

    // Chart Containers
    const chartRevenue = document.getElementById('analyticsChartRevenue');
    const chartFunnel = document.getElementById('analyticsChartFunnel');

    // Report Elements
    const reportCard = document.getElementById('analyticsReportCard');
    const execSummaryEl = document.getElementById('analyticsExecSummary');
    const healthScoreEl = document.getElementById('analyticsHealthScore');
    const strengthsListEl = document.getElementById('analyticsStrengthsList');
    const risksListEl = document.getElementById('analyticsRisksList');
    const forecastConservativeEl = document.getElementById('analyticsForecastConservative');
    const forecastExpectedEl = document.getElementById('analyticsForecastExpected');
    const forecastAggressiveEl = document.getElementById('analyticsForecastAggressive');
    const strategicActionsEl = document.getElementById('analyticsStrategicActions');

    // Actions
    const exportCsvBtn = document.getElementById('analyticsExportCsvBtn');
    const exportJsonBtn = document.getElementById('analyticsExportJsonBtn');
    const copyReportBtn = document.getElementById('analyticsCopyReportBtn');

    async function getSession() {
        if (typeof window.supabaseClient === 'undefined' || !window.supabaseClient?.auth?.getSession) {
            return null;
        }
        try {
            const { data } = await window.supabaseClient.auth.getSession();
            return data?.session || null;
        } catch {
            return null;
        }
    }

    function renderKpiCards(kpis) {
        state.kpis = kpis;
        if (metricMrr) metricMrr.textContent = `$${Number(kpis.mrr || 0).toLocaleString()}`;
        if (metricArr) metricArr.textContent = `$${Number(kpis.arr || 0).toLocaleString()}`;
        if (metricRevenue) metricRevenue.textContent = `$${Number(kpis.revenue || 0).toLocaleString()}`;
        if (metricMargin) metricMargin.textContent = `${kpis.net_margin || 0}%`;
        if (metricCac) metricCac.textContent = `$${Number(kpis.cac || 0).toLocaleString()}`;
        if (metricLtv) metricLtv.textContent = `$${Number(kpis.ltv || 0).toLocaleString()}`;
        if (metricLtvCac) metricLtvCac.textContent = `${kpis.ltv_cac_ratio || 0}x`;
        if (metricChurn) metricChurn.textContent = `${kpis.churn_rate || 0}%`;
    }

    function renderSvgCharts(kpis) {
        if (chartRevenue) {
            const rev = Number(kpis.revenue) || 150000;
            const points = [
                Math.round(rev * 0.72),
                Math.round(rev * 0.79),
                Math.round(rev * 0.88),
                Math.round(rev * 0.94),
                Math.round(rev * 1.0)
            ];
            const max = Math.max(...points) * 1.15;
            const h = 180, w = 480;
            const coords = points.map((p, i) => {
                const x = 30 + (i * ((w - 60) / (points.length - 1)));
                const y = h - 25 - ((p / max) * (h - 50));
                return `${x},${y}`;
            });

            chartRevenue.innerHTML = `
                <svg viewBox="0 0 ${w} ${h}" class="analytics-svg-chart" preserveAspectRatio="none" style="width:100%; height:180px;">
                    <defs>
                        <linearGradient id="revGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                            <stop offset="0%" stop-color="#22d3ee" stop-opacity="0.45" />
                            <stop offset="100%" stop-color="#22d3ee" stop-opacity="0.0" />
                        </linearGradient>
                    </defs>
                    <path d="M 30,${h-25} L ${coords.join(' L ')} L ${w-30},${h-25} Z" fill="url(#revGrad)" />
                    <polyline fill="none" stroke="#22d3ee" stroke-width="3" points="${coords.join(' ')}" />
                    ${coords.map(c => `<circle cx="${c.split(',')[0]}" cy="${c.split(',')[1]}" r="4" fill="#38bdf8" stroke="#ffffff" stroke-width="1.5" />`).join('')}
                    <text x="30" y="${h-8}" fill="#94a3b8" font-size="11">Month -4</text>
                    <text x="${w/2}" y="${h-8}" fill="#94a3b8" font-size="11" text-anchor="middle">Month -2</text>
                    <text x="${w-30}" y="${h-8}" fill="#38bdf8" font-weight="bold" font-size="11" text-anchor="end">Current ($${Number(kpis.revenue).toLocaleString()})</text>
                </svg>
            `;
        }

        if (chartFunnel) {
            const cust = kpis.customers || 340;
            const visitors = Math.round(cust * 35);
            const leads = Math.round(cust * 8);
            const qualified = Math.round(cust * 3.5);

            chartFunnel.innerHTML = `
                <div class="analytics-funnel-bars" style="display:flex; flex-direction:column; gap:10px;">
                    <div class="funnel-row" style="display:flex; align-items:center; gap:10px; font-size:12px;">
                        <span class="funnel-label" style="width:130px; color:#cbd5e1;">Unique Visitors</span>
                        <div class="funnel-bar-track" style="flex:1; height:8px; background:rgba(255,255,255,0.08); border-radius:4px; overflow:hidden;">
                            <div class="funnel-bar-fill" style="width: 100%; height:100%; background:#38bdf8;"></div>
                        </div>
                        <span class="funnel-val" style="width:80px; text-align:right; font-weight:700; color:#38bdf8;">${visitors.toLocaleString()}</span>
                    </div>
                    <div class="funnel-row" style="display:flex; align-items:center; gap:10px; font-size:12px;">
                        <span class="funnel-label" style="width:130px; color:#cbd5e1;">Inquiries &amp; Leads</span>
                        <div class="funnel-bar-track" style="flex:1; height:8px; background:rgba(255,255,255,0.08); border-radius:4px; overflow:hidden;">
                            <div class="funnel-bar-fill" style="width: 32%; height:100%; background:#818cf8;"></div>
                        </div>
                        <span class="funnel-val" style="width:80px; text-align:right; font-weight:700; color:#818cf8;">${leads.toLocaleString()}</span>
                    </div>
                    <div class="funnel-row" style="display:flex; align-items:center; gap:10px; font-size:12px;">
                        <span class="funnel-label" style="width:130px; color:#cbd5e1;">Qualified Trials</span>
                        <div class="funnel-bar-track" style="flex:1; height:8px; background:rgba(255,255,255,0.08); border-radius:4px; overflow:hidden;">
                            <div class="funnel-bar-fill" style="width: 16%; height:100%; background:#c084fc;"></div>
                        </div>
                        <span class="funnel-val" style="width:80px; text-align:right; font-weight:700; color:#c084fc;">${qualified.toLocaleString()}</span>
                    </div>
                    <div class="funnel-row" style="display:flex; align-items:center; gap:10px; font-size:12px;">
                        <span class="funnel-label" style="width:130px; color:#cbd5e1;">Paying Customers</span>
                        <div class="funnel-bar-track" style="flex:1; height:8px; background:rgba(255,255,255,0.08); border-radius:4px; overflow:hidden;">
                            <div class="funnel-bar-fill" style="width: 6%; height:100%; background:#4ade80;"></div>
                        </div>
                        <span class="funnel-val" style="width:80px; text-align:right; font-weight:700; color:#4ade80;">${cust.toLocaleString()}</span>
                    </div>
                </div>
            `;
        }
    }

    function renderReport(report) {
        state.report = report;
        if (!reportCard) return;
        reportCard.hidden = false;

        if (execSummaryEl) execSummaryEl.textContent = report.executive_summary || 'Executive analysis complete.';
        if (healthScoreEl) healthScoreEl.textContent = `${report.health_score || 85}/100`;

        if (strengthsListEl && Array.isArray(report.top_strengths)) {
            strengthsListEl.innerHTML = report.top_strengths.map(s => `<li><i class="fas fa-check-circle" style="color:#4ade80; margin-right:6px;"></i> <span>${escapeHtml(s)}</span></li>`).join('');
        }
        if (risksListEl && Array.isArray(report.top_risks)) {
            risksListEl.innerHTML = report.top_risks.map(r => `<li><i class="fas fa-exclamation-triangle" style="color:#fbbf24; margin-right:6px;"></i> <span>${escapeHtml(r)}</span></li>`).join('');
        }

        if (report.forecast) {
            if (forecastConservativeEl) forecastConservativeEl.textContent = `$${Number(report.forecast.conservative || 0).toLocaleString()}`;
            if (forecastExpectedEl) forecastExpectedEl.textContent = `$${Number(report.forecast.expected || 0).toLocaleString()}`;
            if (forecastAggressiveEl) forecastAggressiveEl.textContent = `$${Number(report.forecast.aggressive || 0).toLocaleString()}`;
        }

        if (strategicActionsEl && Array.isArray(report.strategic_actions)) {
            strategicActionsEl.innerHTML = report.strategic_actions.map((act, i) => `
                <div class="analytics-action-pill glass" style="display:flex; align-items:flex-start; gap:10px; padding:10px 14px; margin-bottom:8px; border-radius:8px; background:rgba(15,23,42,0.6); border:1px solid rgba(255,255,255,0.06);">
                    <strong style="color:#38bdf8; min-width:24px;">P${i+1}</strong>
                    <span style="font-size:12.5px; color:#f1f5f9; line-height:1.4;">${escapeHtml(act)}</span>
                </div>
            `).join('');
        }
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str).replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[s]);
    }

    function updateAllViews() {
        const presetKey = presetSelect ? presetSelect.value : state.activePreset;
        const timeframe = timeframeSelect ? timeframeSelect.value : state.activeTimeframe;
        state.activePreset = presetKey;
        state.activeTimeframe = timeframe;

        const calculated = calculateMetrics(presetKey, timeframe);
        renderKpiCards(calculated.kpis);
        renderSvgCharts(calculated.kpis);
        renderReport(calculated.report);
    }

    async function runAnalyticsReport() {
        const presetKey = presetSelect ? presetSelect.value : state.activePreset;
        const timeframe = timeframeSelect ? timeframeSelect.value : state.activeTimeframe;

        state.isAnalyzing = true;
        if (generateBtn) {
            generateBtn.disabled = true;
            generateBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Calculating KPIs & Forecast...';
        }
        if (statusEl) {
            statusEl.textContent = 'Analyzing unit economics and modeling growth scenarios...';
            statusEl.className = 'analytics-status-msg loading';
        }

        const session = await getSession();
        if (!session) {
            // Local calculation for guest/offline demo
            setTimeout(() => {
                updateAllViews();
                state.isAnalyzing = false;
                if (generateBtn) {
                    generateBtn.disabled = false;
                    generateBtn.innerHTML = '<i class="fas fa-chart-line"></i> Generate Executive Forecast';
                }
                if (statusEl) {
                    statusEl.textContent = 'KPIs and scenario forecasts updated! (Sign in to sync with cloud wallet)';
                    statusEl.className = 'analytics-status-msg success';
                }
                window.showToast?.('Business Analytics report updated!');
            }, 300);
            return;
        }

        const preset = PRESETS[presetKey] || PRESETS.saas_50k;
        const requestId = generateUuid();
        const payload = {
            requestId,
            metrics: state.kpis || preset.baseMetrics,
            businessType: preset.businessType,
            timeframe
        };

        try {
            const res = await fetch('/api/analytics/report', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session.access_token}`,
                    'Idempotency-Key': requestId
                },
                body: JSON.stringify(payload)
            });

            const result = await res.json();
            if (!res.ok) {
                if (res.status === 402) {
                    window.JEVEXA_SHOW_UPGRADE_MODAL?.('Pro', 'Business Analytics credits');
                }
                throw new Error(result.error || 'Failed to generate analytics report.');
            }

            renderKpiCards(result.kpis);
            renderSvgCharts(result.kpis);
            renderReport(result.report);

            if (result.remaining_credits !== undefined) {
                window.JEVEXA_UPDATE_CREDIT_BALANCE?.(result.remaining_credits);
            }
            window.JEVEXA_CREDITS?.fetchBalance?.();
            window.JEVEXA_SYNC_WORKSPACE_CREDITS?.();

            if (statusEl) {
                const costText = result.charged_credits ? ` (${result.charged_credits} credits used)` : '';
                statusEl.textContent = `KPIs and scenario forecasts updated!${costText}`;
                statusEl.className = 'analytics-status-msg success';
            }
            window.showToast?.('Business Analytics report generated!');
        } catch (err) {
            console.warn('Analytics Cloud API notice, activating deterministic fallback:', err);
            updateAllViews();
            if (statusEl) {
                statusEl.textContent = 'Analytics KPIs updated via deterministic modeling engine.';
                statusEl.className = 'analytics-status-msg success';
            }
            window.showToast?.('Analytics report generated!');
        } finally {
            state.isAnalyzing = false;
            if (generateBtn) {
                generateBtn.disabled = false;
                generateBtn.innerHTML = '<i class="fas fa-chart-line"></i> Generate Executive Forecast';
            }
        }
    }

    function init() {
        bindSafe(backBtn, 'click', () => window.JEVEXA_STUDIO?.closeWorkspaces?.());
        bindSafe(closeBtn, 'click', () => window.JEVEXA_STUDIO?.closeWorkspaces?.());
        bindSafe(generateBtn, 'click', runAnalyticsReport);

        // Reactively recalculate on Business Model change
        if (presetSelect) {
            bindSafe(presetSelect, 'change', () => {
                updateAllViews();
                if (statusEl) {
                    statusEl.textContent = `Loaded ${PRESETS[presetSelect.value]?.name || 'model'}. All KPIs and scenario forecasts recalculated.`;
                    statusEl.className = 'analytics-status-msg info';
                }
            });
        }

        // Reactively recalculate on Time Horizon change
        if (timeframeSelect) {
            bindSafe(timeframeSelect, 'change', () => {
                updateAllViews();
                if (statusEl) {
                    statusEl.textContent = `Time horizon switched to ${timeframeSelect.options[timeframeSelect.selectedIndex]?.text || timeframeSelect.value}. Metrics refreshed.`;
                    statusEl.className = 'analytics-status-msg info';
                }
            });
        }

        // Copy Report Action
        bindSafe(copyReportBtn, 'click', () => {
            if (!state.report || !state.kpis) {
                updateAllViews();
            }
            const text = `JEVEXA EXECUTIVE REPORT\nBusiness Model: ${PRESETS[state.activePreset]?.name}\nTime Horizon: ${state.kpis?.timeframe || 'Last 90 Days'}\nHealth Score: ${state.report?.health_score}/100\n\nExecutive Summary:\n${state.report?.executive_summary}\n\nKey Metrics:\n• MRR: $${Number(state.kpis?.mrr).toLocaleString()}\n• ARR: $${Number(state.kpis?.arr).toLocaleString()}\n• Trailing Revenue: $${Number(state.kpis?.revenue).toLocaleString()}\n• Net Margin: ${state.kpis?.net_margin}%\n• LTV/CAC Ratio: ${state.kpis?.ltv_cac_ratio}x\n• Logo Churn: ${state.kpis?.churn_rate}%\n\nRevenue Scenarios (90-Day):\n• Conservative (+6%): $${Number(state.report?.forecast?.conservative).toLocaleString()}\n• Expected (+15%): $${Number(state.report?.forecast?.expected).toLocaleString()}\n• Aggressive (+25%): $${Number(state.report?.forecast?.aggressive).toLocaleString()}\n\nCore Strengths:\n${(state.report?.top_strengths || []).map(s => '• ' + s).join('\n')}\n\nRisks & Bottlenecks:\n${(state.report?.top_risks || []).map(r => '• ' + r).join('\n')}\n\nStrategic Actions:\n${(state.report?.strategic_actions || []).map((a, i) => `P${i+1}: ${a}`).join('\n')}`;
            navigator.clipboard.writeText(text)
                .then(() => {
                    window.showToast?.('Executive report copied to clipboard!');
                    if (statusEl) {
                        statusEl.textContent = 'Report copied to clipboard.';
                        statusEl.className = 'analytics-status-msg success';
                    }
                })
                .catch(() => {
                    downloadFile(`Jevexa_Executive_Report_${new Date().toISOString().split('T')[0]}.txt`, text, 'text/plain');
                    window.showToast?.('Executive report saved as text file!');
                });
        });

        // Export KPIs CSV
        bindSafe(exportCsvBtn, 'click', () => {
            if (!state.kpis) {
                updateAllViews();
            }
            const headers = ['KPI Metric', 'Value', 'Time Horizon'];
            const tf = state.kpis.timeframe || 'Last 90 Days';
            const rows = [
                ['Monthly Recurring Revenue (MRR)', `$${Number(state.kpis.mrr).toLocaleString()}`, tf],
                ['Annual Run Rate (ARR)', `$${Number(state.kpis.arr).toLocaleString()}`, tf],
                ['Trailing Revenue', `$${Number(state.kpis.revenue).toLocaleString()}`, tf],
                ['Operating Expenses', `$${Number(state.kpis.expenses).toLocaleString()}`, tf],
                ['Net Profit', `$${Number(state.kpis.net_profit).toLocaleString()}`, tf],
                ['Net Profit Margin', `${state.kpis.net_margin}%`, tf],
                ['Active Paying Customers', state.kpis.customers, tf],
                ['Customer Acquisition Cost (CAC)', `$${state.kpis.cac}`, tf],
                ['Customer Lifetime Value (LTV)', `$${state.kpis.ltv}`, tf],
                ['LTV / CAC Ratio', `${state.kpis.ltv_cac_ratio}x`, tf],
                ['Logo Churn Rate', `${state.kpis.churn_rate}%`, tf],
                ['MoM Growth Rate', `${state.kpis.mom_growth}%`, tf],
                ['Scenario: Conservative (+6%)', `$${Number(state.report?.forecast?.conservative).toLocaleString()}`, tf],
                ['Scenario: Expected (+15%)', `$${Number(state.report?.forecast?.expected).toLocaleString()}`, tf],
                ['Scenario: Aggressive (+25%)', `$${Number(state.report?.forecast?.aggressive).toLocaleString()}`, tf]
            ].map(r => `"${r[0]}","${r[1]}","${r[2]}"`);

            const csv = [headers.join(','), ...rows].join('\n');
            downloadFile(`Jevexa_KPI_Export_${new Date().toISOString().split('T')[0]}.csv`, '\uFEFF' + csv, 'text/csv;charset=utf-8;');
            window.showToast?.('KPI metrics exported to CSV!');
            if (statusEl) {
                statusEl.textContent = 'Exported KPIs to CSV.';
                statusEl.className = 'analytics-status-msg success';
            }
        });

        // Export Report JSON
        bindSafe(exportJsonBtn, 'click', () => {
            if (!state.kpis || !state.report) {
                updateAllViews();
            }
            const payload = {
                metadata: {
                    businessModel: PRESETS[state.activePreset]?.name,
                    timeHorizon: state.kpis?.timeframe,
                    generatedAt: new Date().toISOString()
                },
                kpis: state.kpis,
                report: state.report
            };
            downloadFile(`Jevexa_Analytics_Report_${new Date().toISOString().split('T')[0]}.json`, JSON.stringify(payload, null, 2), 'application/json');
            window.showToast?.('Executive report exported to JSON!');
            if (statusEl) {
                statusEl.textContent = 'Exported full report to JSON.';
                statusEl.className = 'analytics-status-msg success';
            }
        });

        // Initial default calculation and render
        updateAllViews();
    }

    window.JEVEXA_ANALYTICS = {
        init,
        runReport: runAnalyticsReport,
        calculateMetrics,
        updateAllViews,
        loadPreset: (key) => {
            if (PRESETS[key]) {
                if (presetSelect) presetSelect.value = key;
                updateAllViews();
            }
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
