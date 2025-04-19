//region global variables
const defaultHeadings = ["PollingFirm", "Date", "Citation", "MarginOfError", "SampleSize"];
// TODO: V Should be dynamic based on the data
const parties = ["CPC", "LPC", "NDP", "BQ", "PPC", "GPC", "Others"];
const colors = ["#36A2EB", "#FF6384", "#FF9F40", "#4BC0C0", "#9966FF", "#66FF66", "#FFCE56"];
const dimColors = ["#36A2EB66", "#FF638466", "#FF9F4066", "#4BC0C066", "#9966FF66", "#66FF6666", "#FFCE5666"];

const parameters = getParameters();

let lastApiLoad = 0;
let apiIndex = null;
let apiAccess = {};
let currentDownloadingTasks = 0;

let startDate = null;
let endDate = null;
let biasCharts = [];
let isBlockingGlobalEvents = false;
let generalChart = null;
let disablePadding = false;
let hasSetFirmParameter = false;

let dateRange = {
    start: new Date(),
    end: new Date(),
    min: function() {
        return this.start.getTime()
    },
    max: function() {
        return this.end.getTime()
    }
};

const zoomOptions = {
    pan: {
        enabled: true,
        mode: 'x',
        modifierKey: 'ctrl',
        onPan: updateGlobalZoom
    },
    zoom: {
        drag: {
            enabled: true,
            borderColor: 'rgb(54, 162, 235)',
            borderWidth: 1,
            backgroundColor: 'rgba(54, 162, 235, 0.3)'
        },
        pinch: {
            enabled: true,
            borderColor: 'rgb(54, 162, 235)',
            borderWidth: 1,
            backgroundColor: 'rgba(54, 162, 235, 0.3)'
        },
        mode: 'x',
        onZoom: updateGlobalZoom
    }
};
//endregion

//region api
function loadApi(callback) {
    const currentTime = new Date().getTime();
    // Update every 15 minutes, api only updates every hour anyway
    if (apiIndex == null || lastApiLoad < currentTime - 900000) {
        currentDownloadingTasks++;
        lastApiLoad = currentTime;
        fetch('https://api.pollsteraudit.ca/v1/index.json')
            .then(response => response.json())
            .then(data => {
                currentDownloadingTasks--;
                apiIndex = data;
                callback();
            })
            .catch(error => {
                currentDownloadingTasks--;
                console.error('Error:', error)
            });
    }
}

function getApiTimeRange(from, to) {
    if (apiIndex == null) {
        return;
    }
    let awaitingDownload = false;
    for (let yearName in apiIndex) {
        const year = apiIndex[yearName];
        const range = year["range"];
        if (range[1] >= from && range[0] <= to) { // year.to >= from && year.from <= to
            for (let periodName in year) {
                if (periodName === "range") {
                    continue;
                }
                const period = year[periodName];
                if ("downloaded" in period) {
                    continue;
                }
                const periodRange = period["range"];
                if (periodRange[1] >= from && periodRange[0] <= to) { // period.to >= from && period.from <= to
                    awaitingDownload = true;
                    currentDownloadingTasks++;
                    fetch(period["url"])
                        .then(response => response.json())
                        .then(data => {
                            currentDownloadingTasks--;
                            period["downloaded"] = true; // fast ignore
                            if (!(yearName in apiAccess)) {
                                apiAccess[yearName] = {};
                            }
                            apiAccess[yearName][periodName] = data;
                            if (currentDownloadingTasks === 0) {
                                updateCharts();
                            }
                        })
                        .catch(error => {
                            currentDownloadingTasks--;
                            console.error('Error:', error)
                        });
                }
            }
        }
    }
    if (!awaitingDownload) {
        updateCharts();
    }
}
//endregion

//region charts
// Compute overall averages for each party
function computeOverallAverages(data) {
    let totals = {}, counts = {};
    parties.forEach(p => { totals[p] = 0; counts[p] = 0; });
    data.forEach(d => {
        parties.forEach(p => {
            if (!isNaN(d[p])) {
                totals[p] += d[p];
                counts[p]++;
            }
        });
    });
    let averages = {};
    parties.forEach(p => {
        averages[p] = counts[p] ? totals[p] / counts[p] : 0;
    });
    return averages;
}

// Compute metrics for a given firm's data
function computeMetricsForFirm(data, overallAverages) {
    let metrics = {};
    parties.forEach(p => {
        const values = data.map(d => d[p]).filter(v => !isNaN(v));
        const count = values.length;
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const std = Math.sqrt(values.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / values.length);
        const houseEffect = mean - overallAverages[p];
        const outliers = values.filter(v => Math.abs(v - mean) > 2 * std).length;
        const outlierRatio = count ? outliers / count : 0;
        // Trend: linear regression (convert dates to numeric)
        const x = [];
        const y = [];
        data.forEach(d => {
            if (!isNaN(d[p])) {
                x.push(d.date);
                y.push(d[p]);
            }
        });
        const n = x.length;
        let slope = 0;
        if (n > 1) {
            const sumX = x.reduce((a, b) => a + b, 0);
            const sumY = y.reduce((a, b) => a + b, 0);
            const sumXY = x.reduce((acc, val, i) => acc + val * y[i], 0);
            const sumX2 = x.reduce((acc, val) => acc + val * val, 0);
            slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
        }
        // Convert slope from per millisecond to per day
        const trendSlope = slope * (1000 * 60 * 60 * 24);
        metrics[p] = { mean, std, houseEffect, outliers, outlierRatio, trendSlope };
    });
    // Also compute overall firm metrics (e.g., average margin)
    const marginValues = data.map(d => d.MarginOfError).filter(v => !isNaN(v));
    const avgMargin = marginValues.reduce((a, b) => a + b, 0) / (marginValues.length || 1);
    metrics["Overall"] = { avgMargin };
    return metrics;
}

// Draw the General Polling Data chart (line chart)
function drawGeneralChart() {
    const container = document.getElementById("generalChart");
    if (!container) {
        return;
    }

    if (generalChart) {
        generalChart.destroy(); // Destroy previous chart instance
    }

    const datasets = [];

    // Create the chart
    const ctx = container.getContext("2d");
    generalChart = new Chart(ctx, {
        type: "line",
        data: { datasets },
        options: {
            spanGaps: true,
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    offset: !disablePadding,
                    type: "time",
                    time: {
                        unit: 'day',
                        round: true
                    },
                    grid: { color: theme === "dark" ? "#FFFFFF44" : "rgba(0,0,0,0.1)" },
                    title: { display: true, text: lang_chart_date }
                },
                y: {
                    grid: { color: theme === "dark" ? "#FFFFFF44" : "rgba(0,0,0,0.1)" },
                    title: { display: true, text: lang_chart_pollingPercentage }
                }
            },
            plugins: {
                title: {
                    display: true,
                    text: lang_chart_firmTrendOverTime
                },
                tooltip: {
                    callbacks: {
                        title: function(context) {
                            return new Date(context[0].parsed.x).toLocaleDateString();
                        },
                        label: (context) => {
                            const label = context.dataset.label || '';
                            const firm = context.raw.firm || '';
                            return `${label}: ${context.raw.y}% (${firm})`;
                        }
                    }
                },
                zoom: zoomOptions,
                regressionTrendline: {
                    enabled: true,
                    type: 'local',
                    span: 0.25,         // 25% neighborhood
                    degree: 2,          // local quadratic fit
                    borderWidth: 2,
                    weightField: 'weight'
                }
            },
            locale: lang_site_locale,
            normalized: true,
            parsing: false
        }
    });
}

function generateDataset() {
    const data = [];
    for (let yearName in apiAccess) {
        const year = apiAccess[yearName];
        for (let periodName in year) {
            if (periodName === "range") {
                continue;
            }
            const period = year[periodName];
            const headings = period["headings"];
            for (const d of period["data"]) {
                const date = d[headings.indexOf("Date")];
                if (dateRange.min() !== dateRange.max()) { // Not first time
                    if (date < dateRange.min() || date > dateRange.max()) {
                        continue;
                    }
                }
                const marginOfErrorIndex = headings.indexOf("MarginOfError");
                const sampleSizeIndex = headings.indexOf("SampleSize");
                const dataLine = {
                    PollingFirm: d[headings.indexOf("PollingFirm")],
                    date: date,
                    MarginOfError: marginOfErrorIndex === -1 ? null : d[marginOfErrorIndex],
                    SampleSize: sampleSizeIndex === -1 ? null : d[sampleSizeIndex]
                };
                for (const heading of headings) {
                    if (!defaultHeadings.includes(heading)) {
                        dataLine[heading] = d[headings.indexOf(heading)];
                    }
                }
                if (startDate == null || dataLine.date < startDate.getTime()) {
                    startDate = new Date(dataLine.date);
                }
                if (endDate == null || dataLine.date > endDate.getTime()) {
                    endDate = new Date(dataLine.date);
                }

                data.push(dataLine);
            }
        }
    }
    return data;
}

function updateGeneralChartData(selectedFirm = null) {
    const firmSelector = document.getElementById('firmSelector');
    if (!firmSelector) {
        return;
    }

    const data = generateDataset();

    const firms = [...new Set(data.map(d => d.PollingFirm))];

    // Populate dropdown options
    firms.forEach(firm => {
        const option = document.createElement('option');
        option.value = firm;
        option.textContent = firm;
        firmSelector.appendChild(option);
    });

    if (!hasSetFirmParameter) {
        hasSetFirmParameter = true;
        if ("firm" in parameters) {
            firmSelector.value = decodeURIComponent(parameters["firm"]);
            selectedFirm = firmSelector.value;
        }
    }

    const newDatasets = [];

    // Prepare data for each party
    parties.forEach((p, index) => {
        const partyData = data
            .filter(d => !isNaN(d[p]))
            .map(d => ({
                x: d.date,
                y: d[p],
                firm: d.PollingFirm,
                SampleSize: d.SampleSize,
                MarginOfError: d.MarginOfError
            }))
            .sort((a, b) => a.x - b.x);

        // This is how we calculate weights per data point!
        const weightedPartyData = WeightStrategies.applyWeights(
            partyData,
            WeightStrategies.combineWeightFns([
                WeightStrategies.logScaled('SampleSize'),
                WeightStrategies.inverseError('MarginOfError', 2.5)
            ])
        );

        newDatasets.push({
            label: p,
            data: weightedPartyData,
            borderColor: selectedFirm ? dimColors[index] : colors[index],
            showLine: false, // We only want to show the trendline
            backgroundColor: selectedFirm ? dimColors[index] : colors[index],
            fill: false,
            borderWidth: selectedFirm ? 1 : 2,
            pointRadius: 2,
            pointBackgroundColor: dimColors[index], //selectedFirm ? dimColors[index] : colors[index],
            pointBorderColor: dimColors[index], //selectedFirm ? dimColors[index] : colors[index],
            pointHitRadius: 2
        });
    });

    // Highlight selected firm
    if (selectedFirm) {
        parties.forEach((p, index) => {
            const firmData = data
                .filter(d => d.PollingFirm === selectedFirm && !isNaN(d[p]))
                .map(d => ({ x: d.date, y: d[p] }))
                .sort((a, b) => a.x - b.x);

            if (firmData.length) {
                newDatasets.push({
                    label: `${p} (${selectedFirm})`,
                    data: firmData,
                    borderColor: colors[index],
                    backgroundColor: colors[index],
                    borderWidth: 2, // Thicker line for emphasis
                    pointRadius: 3,
                    fill: false,
                    pointBackgroundColor: colors[index],
                    pointBorderColor: colors[index],
                    pointHitRadius: 2,
                    regressionTrendline: {
                        showLine: false
                    }
                });
            }
        });
    }

    // Apply the zoom scale
    applyZoomScale(generalChart);

    // Update datasets directly for smooth animations
    generalChart.data.datasets = newDatasets;
    generalChart.update('none'); // Smooth transition
}

// Sort firms based on the amount of polls they have done in the last 6 months
function sortPollingFirms(data) {
    // Filter data for the last 6 months
    const cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - 6);

    const recentData = data.filter(d => d.date >= cutoffDate);

    // Group and count polls per firm within the last 6 months
    const firmPollCount = {};
    recentData.forEach(d => {
        firmPollCount[d.PollingFirm] = (firmPollCount[d.PollingFirm] || 0) + 1;
    });

    // Sort firms by poll count in descending order
    const sortedFirms = Object.keys(firmPollCount)
        .sort((a, b) => firmPollCount[b] - firmPollCount[a]);
    data.forEach(d => {
        if (!sortedFirms.includes(d.PollingFirm)) {
            sortedFirms.push(d.PollingFirm);
        }
    });
    return sortedFirms;
}

// Draw bias analysis charts for each polling firm with expanded metrics
function drawBiasAnalysis() {
    const container = document.getElementById("biasAnalysisContainer");
    if (!container) {
        return;
    }

    const data = generateDataset();

    const overallAverages = computeOverallAverages(data);
    container.innerHTML = ""; // Clear previous content

    // Sort firms by poll count in descending order
    const sortedFirms = sortPollingFirms(data);

    sortedFirms.forEach(firm => {
        const firmData = data.filter(d => d.PollingFirm === firm);
        const metrics = computeMetricsForFirm(firmData, overallAverages);

        // Create a div for this firm
        const firmDiv = document.createElement("div");
        firmDiv.className = "firm-analysis";
        firmDiv.classList.add("firm-analysis", "col");

        // Firm title and overall info
        const firmTitle = document.createElement("h3");
        firmTitle.textContent = `${lang_firm_pollingFirm}: ${firm}`;
        firmDiv.appendChild(firmTitle);

        // Create a table for party metrics
        const tableWrapper = document.createElement("div");
        tableWrapper.classList.add("table-responsive");
        const table = document.createElement("table");
        const thead = document.createElement("thead");
        thead.innerHTML = `<tr>
            <th>${lang_data_party}</th>
            <th>${lang_data_mean}</th>
            <th>${lang_data_stdDev}</th>
            <th>${lang_data_houseEffect}</th>
            <th>${lang_data_outliers}</th>
            <th>${lang_data_outlierRatio}</th>
            <th>${lang_data_trend}</th>
          </tr>`;
        table.appendChild(thead);
        const tbody = document.createElement("tbody");
        parties.forEach(p => {
            const row = document.createElement("tr");
            row.innerHTML = `<td>${p}</td>
            <td>${metrics[p].mean.toFixed(2)}</td>
            <td>${metrics[p].std.toFixed(2)}</td>
            <td>${metrics[p].houseEffect.toFixed(2)}</td>
            <td>${metrics[p].outliers}</td>
            <td>${metrics[p].outlierRatio.toFixed(2)}</td>
            <td>${metrics[p].trendSlope.toFixed(4)}</td>`;
            tbody.appendChild(row);
        });
        table.appendChild(tbody);
        tableWrapper.appendChild(table);
        firmDiv.appendChild(tableWrapper);

        // 1. Firm Polling Trend Chart (line chart for each party)
        const trendCanvasWrapper = document.createElement("div");
        trendCanvasWrapper.classList.add("table-responsive");
        const trendCanvas = document.createElement("canvas");
        trendCanvas.style.minHeight = "300px";
        const trendCanvasId = "chart-firmTrend-" + firm.replace(/\s+/g, "_");
        trendCanvas.id = trendCanvasId;
        trendCanvasWrapper.appendChild(trendCanvas);
        firmDiv.appendChild(trendCanvasWrapper);

        // 2. Distribution Box Plot (using Chart.js BoxPlot plugin)
        const boxCanvasWrapper = document.createElement("div");
        boxCanvasWrapper.classList.add("table-responsive");
        const boxCanvas = document.createElement("canvas");
        boxCanvas.style.minHeight = "300px";
        const boxCanvasId = "chart-boxplot-" + firm.replace(/\s+/g, "_");
        boxCanvas.id = boxCanvasId;
        boxCanvasWrapper.appendChild(boxCanvas);
        firmDiv.appendChild(boxCanvasWrapper);

        container.appendChild(firmDiv);

        // Create Firm Polling Trend Chart (line chart for each party)
        const datasetsTrend = [];
        parties.forEach((p, index) => {
            let partyData = firmData.filter(d => !isNaN(d[p])).map(d => ({ x: d.date, y: d[p] }));
            partyData.sort((a, b) => a.x - b.x);
            datasetsTrend.push({
                label: p,
                data: partyData,
                borderColor: colors[index],
                backgroundColor: colors[index],
                fill: false
            });
        });
        const ctxTrend = document.getElementById(trendCanvasId).getContext("2d");
        const latestChart = new Chart(ctxTrend, {
            type: "line",
            data: { datasets: datasetsTrend },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    x: {
                        offset: !disablePadding,
                        type: "time",
                        time: {
                            unit: "day",
                            displayFormats: {
                                quarter: 'DD MMM YYYY'
                            }
                        },
                        grid: { color: theme === "dark" ? "#FFFFFF44" : "rgba(0,0,0,0.1)" },
                        title: { display: true, text: lang_chart_date }
                    },
                    y: {
                        grid: { color: theme === "dark" ? "#FFFFFF44" : "rgba(0,0,0,0.1)" },
                        title: { display: true, text: lang_chart_pollingPercentage }
                    }
                },
                plugins: {
                    title: {
                        display: true,
                        text: lang_chart_firmTrendOverTime
                    },
                    zoom: zoomOptions,
                    tooltip: {
                        callbacks: {
                            title: function(context) {
                                return new Date(context[0].parsed.x).toLocaleDateString();
                            }
                        }
                    }
                },
                locale: lang_site_locale,
                normalized: true,
                parsing: false
            }
        });
        applyZoomScale(latestChart);
        biasCharts.push(latestChart);

        // Create Distribution Box Plot Chart
        // For each party, prepare an array of polling values
        const datasetsBox = parties.map((p, index) => {
            const values = firmData.map(d => d[p]).filter(v => !isNaN(v));
            return {
                label: p,
                backgroundColor: colors[index],
                borderColor: colors[index],
                borderWidth: 1,
                outlierColor: '#666666',
                itemRadius: 0,
                data: [values] // BoxPlot plugin expects data as an array of arrays.
            };
        });
        const ctxBox = document.getElementById(boxCanvasId).getContext("2d");
        const boxChart = new Chart(ctxBox, {
            type: 'boxplot',
            data: {
                labels: [lang_chart_distribution],
                datasets: datasetsBox
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    title: {
                        display: true,
                        text: lang_chart_pollingPercentagesDistribution
                    }
                },
                scales: {
                    x: {
                        grid: { color: theme === "dark" ? "#FFFFFF44" : "rgba(0,0,0,0.1)" },
                    },
                    y: {
                        grid: { color: theme === "dark" ? "#FFFFFF44" : "rgba(0,0,0,0.1)" },
                    }
                },
                locale: lang_site_locale
            }
        });
        biasCharts.push(boxChart);
    });
}

function updateCharts(forceRangeUpdate = false) {
    if (generalChart != null) {
        const selectedFirm = document.getElementById('firmSelector').value;
        updateGeneralChartData(selectedFirm);
    }
    drawBiasAnalysis();

    if (forceRangeUpdate) {
        setRange(startDate, endDate);
    }
}

// Initialize the graphs, although it doesn't set the data
function drawCharts() {
    // Draw the general polling data chart
    drawGeneralChart();
    // Draw expanded bias analysis charts for each polling firm
    drawBiasAnalysis();
}

function applyZoomScale(graph) {
    isBlockingGlobalEvents = true;
    graph.zoomScale("x", {"min": dateRange.min(), "max": dateRange.max()}, "zoom");
    isBlockingGlobalEvents = false;
}

function updateGlobalZoom(event) {
    if (isBlockingGlobalEvents) {
        return;
    }
    isBlockingGlobalEvents = true;
    const chart = event.chart;
    const zoomBounds = chart.getZoomedScaleBounds();
    dateRange.start = new Date(zoomBounds.x.min);
    dateRange.end = new Date(zoomBounds.x.max);
    biasCharts.forEach(otherChart => {
        if (otherChart !== chart) {
            otherChart.zoomScale("x", {"min": dateRange.min(), "max": dateRange.max()}, "zoom");
        }
    });
    if (generalChart != null) {
        generalChart.zoomScale("x", {"min": dateRange.min(), "max": dateRange.max()}, "zoom");
    }
    disablePadding = true;
    setRange(dateRange.start, dateRange.end, false)
    isBlockingGlobalEvents = false;
    drawBiasAnalysis(); // TODO: Update graph datasets so that the animation is smooth
}
//endregion

//region date range
function formatDate(date) {
    return date.toISOString().split('T')[0];
}

function setRange(start, end, updateData=true, label=null) {
    if (start == null) {
        document.getElementById('startDate').value = formatDate(startDate == null ? end : startDate);
    } else {
        document.getElementById('startDate').value = formatDate(start);
    }

    document.getElementById('endDate').value = formatDate(end);

    if (start == null) {
        // TODO: end label?
        setButtonLabel(label == null ? lang_time_all : label);
        if (startDate == null) {
            updateDateRange(end, end, updateData);
        } else {
            updateDateRange(startDate, end, updateData);
        }
    } else {
        if (end === endDate) {
            setButtonLabel(label == null ? `${lang_time_since} ${formatDate(start)}` : label)
        } else {
            if (label == null) {
                updateButtonLabel(formatDate(start), formatDate(end));
            } else {
                setButtonLabel(label)
            }
        }
        updateDateRange(start, end, updateData);
    }
    if (label !== lang_time_all) { // Default
        const newStart = start == null ? null : formatDate(start);
        const newEnd = (end == null || end === endDate) ? null : formatDate(end);
        let newUrl = updateUrlParameter(
            updateUrlParameter(window.location.href, "startDate", newStart),
            "endDate",
            newEnd
        );
        if (window.location.href !== newUrl) {
            window.history.pushState({ startDate: newStart, endDate: newEnd }, '', newUrl);
        }
    }
}

function setRangeToLastPeriod() {
    if (apiIndex == null) {
        return;
    }
    let latestYear;
    let latestTime = 0;
    for (let yearName in apiIndex) {
        const year = apiIndex[yearName];
        const range = year["range"];
        if (range[1] >= latestTime) {
            latestYear = yearName;
            latestTime = range[1];
        }
    }
    let latestPeriod;
    let latestRange = null;
    const year = apiIndex[latestYear];
    for (let periodName in year) {
        if (periodName === "range") {
            continue;
        }
        const period = year[periodName];
        const periodRange = period["range"];
        if (latestRange == null || periodRange[1] >= latestRange[1]) {
            latestRange = periodRange;
            latestPeriod = periodName;
        }
    }
    return latestRange;
}

/**
 * Gets the start date of the last election in the data. <br>
 * Last election won't be based on your current graph. Although we could implement that in the future
 */
function getLatestElectionStart() {
    if (apiIndex == null) {
        return null;
    }
    let latestYear;
    let latestTime = 0;
    for (let yearName in apiIndex) {
        const year = apiIndex[yearName];
        const range = year["range"];
        if (range[1] >= latestTime) {
            latestYear = yearName;
            latestTime = range[1];
        }
    }
    return new Date(apiIndex[latestYear]["range"][0])
}

/**
 * Gets the date range of the last campaign period. <br>
 * This will get the last years campaign period if we aren't currently in a campaign period.
 * Should inform the user about this somehow.
 * <p>
 * Looks for the latest period with id `campaign_period` from the api.
 */
function getLatestCampaignPeriod() {
    if (apiIndex == null) {
        return null;
    }
    let latestYear;
    let latestRange = null;
    for (let yearName in apiIndex) {
        const year = apiIndex[yearName];
        if ("campaign_period" in year) {
            const range = year["campaign_period"]["range"];
            if (latestRange == null || range[1] >= latestRange[1]) {
                latestYear = yearName;
                latestRange = range;
            }
        }
    }
    return [new Date(latestRange[0]), new Date(latestRange[1])];
}

/**
 * Gets the date range of the last pre-campaign period. <br>
 * <p>
 * Instead of looking for a period with id `pre-campaign_period`, we instead take the latest year and remove
 * `campaign_period`. We do this since its possible that the pre-campaign graph got split. <p>
 * E.x. 2004 has `campaign_period`, `pre-campaign_period`, & `pre-conservative`.
 * Where the two last ones are technically both the per-campaign. <p>
 * We don't currently account for a campaign period to split into two, as its incredibly unlikely that a party would
 * do this halfway through a campaign period.
 */
function getLatestPreCampaignPeriod() {
    if (apiIndex == null) {
        return null;
    }
    let latestYear;
    let latestTime = 0;
    for (let yearName in apiIndex) {
        const year = apiIndex[yearName];
        const range = year["range"];
        if (range[1] >= latestTime) {
            latestYear = yearName;
            latestTime = range[1];
        }
    }
    let preCampaignRange = null;
    for (let periodName in apiIndex[latestYear]) {
        if (periodName !== "campaign_period" && periodName !== "range") {
            const tempRange = apiIndex[latestYear][periodName]["range"];
            if (preCampaignRange == null) {
                preCampaignRange = tempRange;
            } else {
                if (tempRange[0] < preCampaignRange[0]) {
                    preCampaignRange[0] = tempRange[0];
                }
                if (tempRange[1] > preCampaignRange[1]) {
                    preCampaignRange[1] = tempRange[1];
                }
            }
        }
    }
    return [new Date(preCampaignRange[0]), new Date(preCampaignRange[1])];
}

function setRangeFormat(range, fromStartup=true) {
    let start, end;
    let label = null;

    switch (range) {
        case 'last7':
            start = new Date();
            start.setDate(endDate.getDate() - 6);
            end = endDate;
            label = lang_time_last7Days;
            break;
        case 'last30':
            start = new Date();
            start.setDate(endDate.getDate() - 29);
            end = endDate;
            label = lang_time_last30Days;
            break;
        case 'last6Months':
            start = new Date();
            start.setMonth(endDate.getMonth() - 6);
            end = endDate;
            label = lang_time_last6Months;
            break;
        case 'sinceLastElection':
            start = getLatestElectionStart();
            end = endDate;
            label = lang_time_sinceLastElection;
            break;
        case 'campaignPeriod':
            const campaignRange = getLatestCampaignPeriod();
            start = campaignRange?.[0];
            end = campaignRange?.[1] ?? endDate;
            label = lang_time_campaignPeriod;
            break;
        case 'preCampaignPeriod':
            const preCampaignRange = getLatestPreCampaignPeriod();
            start = preCampaignRange?.[0];
            end = preCampaignRange?.[1] ?? endDate;
            label = lang_time_preCampaignPeriod;
            break;
        case 'all':
            // This currently only returns all data that you've seen so far. No all data in general. This is intended
            start = null;
            end = endDate;
            label = lang_time_all;
            break;
    }
    disablePadding = false;
    setRange(start, end, fromStartup, label);
    drawBiasAnalysis();
}

function applyCustomRange() {
    const start = new Date(document.getElementById('startDate').value);
    const end = new Date(document.getElementById('endDate').value);
    if (start > end) {
        alert(lang_time_mustBeBefore);
        return;
    }
    bootstrap.Dropdown.getInstance(document.getElementById('dateRangeButton')).hide();
    setRange(start, end);
}

function updateButtonLabel(formattedStart, formattedEnd) {
    setButtonLabel(`${formattedStart} ${lang_time_to} ${formattedEnd}`);
}

function setButtonLabel(text) {
    document.getElementById('dateRangeButton').textContent = text;
}

function updateDateRange(start, end, updateGraphs) {
    if (updateGraphs) {
        dateRange.start = start;
        dateRange.end = end;
        getApiTimeRange(start, end);

        isBlockingGlobalEvents = true;
        if (biasCharts) {
            biasCharts.forEach(otherChart => {
                otherChart.zoomScale("x", {"min": dateRange.min(), "max": dateRange.max()}, "zoom");
            });
        }
        if (generalChart) {
            generalChart.zoomScale("x", {"min": dateRange.min(), "max": dateRange.max()}, "zoom");
        }
        isBlockingGlobalEvents = false;
    }
}
//endregion

//region url parameters
function updateUrlParameter(url, param, paramVal) {
    let newAdditionalUrl = "";
    let tempArray = url.split("?");
    const baseURL = tempArray[0];
    let additionalURL = tempArray[1];
    let temp = "";
    if (additionalURL) {
        tempArray = additionalURL.split("&");
        for (let i=0; i<tempArray.length; i++) {
            if (tempArray[i].split('=')[0] !== param) {
                newAdditionalUrl += temp + tempArray[i];
                temp = "&";
            }
        }
    }
    if (paramVal == null) {
        const addition = newAdditionalUrl + temp.replace(/&+$/, "");
        return baseURL + (addition === "" ? "" : "?" + addition);
    }
    return baseURL + "?" + newAdditionalUrl + temp + "" + param + "=" + paramVal;
}

function getParameters() {
    let paramString = window.location.search.substring(1);
    let params_arr = paramString.split('&');
    const parametersMap = {};
    for (let i = 0; i < params_arr.length; i++) {
        let pair = params_arr[i].split('=');
        parametersMap[pair[0]] = pair[1];
    }
    return parametersMap;
}
//endregion

//region startup
if (document.getElementById("dateRangeButton") != null) {
    loadApi(() => {
        if ("startDate" in parameters || "endDate" in parameters) {
            let start = null;
            if ("startDate" in parameters) {
                start = new Date(parameters["startDate"]);
            }
            setRange(
                start,
                "endDate" in parameters ? new Date(parameters["endDate"]) :
                    (endDate == null ? new Date() : endDate),
                true
            );
        } else {
            const range = setRangeToLastPeriod();
            setRange(
                range == null ? startDate : new Date(range[0]),
                range == null ? endDate : new Date(range[1]),
                true
            );
            disablePadding = false;
        }

        drawCharts();
    });
}

window.addEventListener('DOMContentLoaded', () => {
    const themeToggler = document.getElementById("theme-toggle");
    themeToggler.addEventListener("click", function(){
        // Delayed to make sure the theme has been set
        setTimeout(() => {
            const gridColor = theme === "dark" ? "#FFFFFF44" : "rgba(0,0,0,0.1)";
            if (generalChart != null) {
                generalChart.options.scales.x.grid.color = gridColor;
                generalChart.options.scales.y.grid.color = gridColor;
                generalChart.update('none');
            }
            if (biasCharts != null) {
                biasCharts.forEach(chart => {
                    chart.options.scales.x.grid.color = gridColor;
                    chart.options.scales.y.grid.color = gridColor;
                    chart.update('none');
                });
            }
        }, 1);
    }, false);

    const firmSelector = document.getElementById('firmSelector');
    if (firmSelector != null) {
        firmSelector.addEventListener("change", function(){
            updateCharts();
            const firm = firmSelector.value === "" ? null : firmSelector.value;
            let newUrl = updateUrlParameter(
                window.location.href,
                "firm",
                firm
            );
            if (window.location.href !== newUrl) {
                window.history.pushState({ firm: firm }, '', newUrl);
            }
        }, false);
    }
});
//endregion