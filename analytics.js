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

    const state = {
        kpis: null,
        report: null,
        isAnalyzing: false,
        activePreset: 'saas_50k'
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

    const PRESETS = {
        saas_50k: {
            name: "B2B SaaS Growth ($50k MRR)",
            businessType: "saas",
            metrics: {
                mrr: 48500,
                revenue: 145500,
                expenses: 61000,
                customers: 340,
                cac: 240,
                ltv: 1850,
                churn: 2.1,
                growth: 14.5
            }
        },
        ecommerce_120k: {
            name: "E-Commerce Brand ($120k GMV)",
            businessType: "ecommerce",
            metrics: {
                mrr: 120000,
                revenue: 360000,
                expenses: 245000,
                customers: 2850,
                cac: 38,
                ltv: 126,
                churn: 4.8,
                growth: 18.2
            }
        },
        agency_35k: {
            name: "Digital Agency ($35k/mo)",
            businessType: "agency",
            metrics: {
                mrr: 35000,
                revenue: 105000,
                expenses: 42000,
                customers: 14,
                cac: 1200,
                ltv: 12500,
                churn: 1.2,
                growth: 8.5
            }
        }
    };

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
                <svg viewBox="0 0 ${w} ${h}" class="analytics-svg-chart" preserveAspectRatio="none">
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
            chartFunnel.innerHTML = `
                <div class="analytics-funnel-bars">
                    <div class="funnel-row">
                        <span class="funnel-label">Unique Visitors</span>
                        <div class="funnel-bar-track"><div class="funnel-bar-fill" style="width: 100%;"></div></div>
                        <span class="funnel-val">100% (14,200)</span>
                    </div>
                    <div class="funnel-row">
                        <span class="funnel-label">Product Inquiries / Leads</span>
                        <div class="funnel-bar-track"><div class="funnel-bar-fill" style="width: 32%;"></div></div>
                        <span class="funnel-val">32% (4,544)</span>
                    </div>
                    <div class="funnel-row">
                        <span class="funnel-label">Active Trials / Qualified</span>
                        <div class="funnel-bar-track"><div class="funnel-bar-fill" style="width: 14%;"></div></div>
                        <span class="funnel-val">14% (1,988)</span>
                    </div>
                    <div class="funnel-row">
                        <span class="funnel-label">Closed / Paying Customers</span>
                        <div class="funnel-bar-track"><div class="funnel-bar-fill" style="width: 4.8%;"></div></div>
                        <span class="funnel-val">4.8% (${kpis.customers || 340})</span>
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
            strengthsListEl.innerHTML = report.top_strengths.map(s => `<li><i class="fas fa-check-circle"></i> <span>${escapeHtml(s)}</span></li>`).join('');
        }
        if (risksListEl && Array.isArray(report.top_risks)) {
            risksListEl.innerHTML = report.top_risks.map(r => `<li><i class="fas fa-exclamation-triangle"></i> <span>${escapeHtml(r)}</span></li>`).join('');
        }

        if (report.forecast) {
            if (forecastConservativeEl) forecastConservativeEl.textContent = `$${Number(report.forecast.conservative || 0).toLocaleString()}`;
            if (forecastExpectedEl) forecastExpectedEl.textContent = `$${Number(report.forecast.expected || 0).toLocaleString()}`;
            if (forecastAggressiveEl) forecastAggressiveEl.textContent = `$${Number(report.forecast.aggressive || 0).toLocaleString()}`;
        }

        if (strategicActionsEl && Array.isArray(report.strategic_actions)) {
            strategicActionsEl.innerHTML = report.strategic_actions.map((act, i) => `
                <div class="analytics-action-pill glass">
                    <strong>P${i+1}</strong>
                    <span>${escapeHtml(act)}</span>
                </div>
            `).join('');
        }
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str).replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[s]);
    }

    async function runAnalyticsReport() {
        const session = await getSession();
        if (!session) {
            window.showToast?.('Please sign in or create an account to run Business Analytics.');
            window.openAuthModal?.('signup');
            return;
        }

        const presetKey = presetSelect ? presetSelect.value : 'saas_50k';
        const preset = PRESETS[presetKey] || PRESETS.saas_50k;
        const timeframe = timeframeSelect ? timeframeSelect.value : '90d';

        state.isAnalyzing = true;
        if (generateBtn) {
            generateBtn.disabled = true;
            generateBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Calculating KPIs & Forecast...';
        }
        if (statusEl) {
            statusEl.textContent = 'Analyzing unit economics and modeling growth scenarios...';
            statusEl.className = 'analytics-status-msg loading';
        }

        const requestId = generateUuid();
        const payload = {
            requestId,
            metrics: preset.metrics,
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
                throw new Error(result.error || 'Failed to generate analytics report.');
            }

            renderKpiCards(result.kpis);
            renderSvgCharts(result.kpis);
            renderReport(result.report);

            if (statusEl) {
                statusEl.textContent = 'KPIs and scenario forecasts updated!';
                statusEl.className = 'analytics-status-msg success';
            }
            window.showToast?.('Business Analytics report generated!');
            window.JEVEXA_CREDITS?.fetchBalance?.();
        } catch (err) {
            console.error('Analytics error:', err);
            if (statusEl) {
                statusEl.textContent = err.message || 'Analysis failed. Please try again.';
                statusEl.className = 'analytics-status-msg error';
            }
            window.showToast?.(err.message || 'Analytics report failed.');
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

        if (presetSelect) {
            bindSafe(presetSelect, 'change', () => {
                const p = PRESETS[presetSelect.value];
                if (p) {
                    renderKpiCards(p.metrics);
                    renderSvgCharts(p.metrics);
                    if (statusEl) {
                        statusEl.textContent = `Loaded ${p.name}. Click "Generate Executive Forecast" for deep modeling.`;
                        statusEl.className = 'analytics-status-msg info';
                    }
                }
            });
        }

        // Copy Report Action
        bindSafe(copyReportBtn, 'click', () => {
            if (!state.report) return;
            const text = `JEVEXA EXECUTIVE REPORT\nHealth Score: ${state.report.health_score}/100\n\n${state.report.executive_summary}\n\nKey Strengths:\n${state.report.top_strengths.join('\n')}\n\nStrategic Actions:\n${state.report.strategic_actions.join('\n')}`;
            navigator.clipboard.writeText(text)
                .then(() => window.showToast?.('Executive report copied to clipboard!'))
                .catch(() => window.showToast?.('Could not copy report.'));
        });

        // Export CSV
        bindSafe(exportCsvBtn, 'click', () => {
            if (!state.kpis) return;
            const headers = ['Metric', 'Value'];
            const rows = Object.entries(state.kpis).map(([k, v]) => [k, v].join(','));
            const csv = [headers.join(','), ...rows].join('\n');
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `Jevexa_KPI_Export_${new Date().toISOString().split('T')[0]}.csv`;
            link.click();
            window.showToast?.('KPI metrics exported to CSV!');
        });

        // Export JSON
        bindSafe(exportJsonBtn, 'click', () => {
            if (!state.kpis && !state.report) return;
            const payload = { kpis: state.kpis, report: state.report };
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `Jevexa_Analytics_Report_${new Date().toISOString().split('T')[0]}.json`;
            link.click();
            window.showToast?.('Executive report exported to JSON!');
        });

        // Render initial preset
        const defaultPreset = PRESETS.saas_50k;
        renderKpiCards(defaultPreset.metrics);
        renderSvgCharts(defaultPreset.metrics);
    }

    window.JEVEXA_ANALYTICS = {
        init,
        runReport: runAnalyticsReport,
        loadPreset: (key) => {
            if (PRESETS[key]) {
                if (presetSelect) presetSelect.value = key;
                renderKpiCards(PRESETS[key].metrics);
                renderSvgCharts(PRESETS[key].metrics);
            }
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
