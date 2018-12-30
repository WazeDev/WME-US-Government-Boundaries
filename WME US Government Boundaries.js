/* eslint-disable no-template-curly-in-string */
// ==UserScript==
// @name            WME US Government Boundaries
// @namespace       https://greasyfork.org/users/45389
// @version         2018.12.30.001
// @description     Adds a layer to display US (federal, state, and/or local) boundaries.
// @author          MapOMatic
// @include         /^https:\/\/(www|beta)\.waze\.com\/(?!user\/)(.{2,6}\/)?editor\/?.*$/
// @require         https://cdnjs.cloudflare.com/ajax/libs/Turf.js/4.7.3/turf.min.js
// @require         https://greasyfork.org/scripts/24851-wazewrap/code/WazeWrap.js
// @grant           GM_xmlhttpRequest
// @license         GNU GPLv3
// @contributionURL https://github.com/WazeDev/Thank-The-Authors
// @connect         census.gov
// @connect         wazex.us
// @connect         usps.com
// ==/UserScript==

/* global $ */
/* global OL */
/* global GM_info */
/* global W */
/* global GM_xmlhttpRequest */
/* global turf */
/* global WazeWrap */
/* global localStorage */
/* global alert */

const SETTINGS_STORE_NAME = 'wme_us_government_boundaries';
const ALERT_UPDATE = false;
const ZIPS_LAYER_URL = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/PUMA_TAD_TAZ_UGA_ZCTA/MapServer/4/';
const COUNTIES_LAYER_URL = 'https://tigerweb.geo.census.gov/arcgis/rest/services/Census2010/State_County/MapServer/1/';
const USPS_ROUTE_COLORS = ['#f00', '#0a0', '#00f', '#a0a', '#6c82cb', '#0aa'];
const USPS_ROUTES_URL_TEMPLATE = 'https://gis.usps.com/arcgis/rest/services/EDDM/selectNear/GPServer/routes/execute?f=json&env%3AoutSR=102100&'
    + 'Selecting_Features=%7B%22geometryType%22%3A%22esriGeometryPoint%22%2C%22features%22%3A%5B%7B%22'
    + 'geometry%22%3A%7B%22x%22%3A{lon}%2C%22y%22%3A{lat}%2C%22spatialReference%22%3A%7B%22wkid%22%3A'
    + '102100%2C%22latestWkid%22%3A3857%7D%7D%7D%5D%2C%22sr%22%3A%7B%22wkid%22%3A102100%2C%22latestWkid'
    + '%22%3A3857%7D%7D&Distance={radius}&Rte_Box=R&userName=EDDM';
const USPS_ROUTES_RADIUS = 0.5; // miles
const PROCESS_CONTEXTS = [];
const SCRIPT_VERSION = GM_info.script.version;
const SCRIPT_VERSION_CHANGES = [
    GM_info.script.name,
    `v${SCRIPT_VERSION}`,
    '',
    'What\'s New',
    '------------------------------'
    // add new stuff here
].join('\n');
let _zipsLayer;
let _countiesLayer;
let _uspsRoutesMapLayer = null;
let _circleFeature;
let _$resultsDiv;
let _$getRoutesButton;
let _settings = {};

function log(message) {
    console.log('USGB:', message);
}

// Recursively checks the settings object and fills in missing properties from the
// default settings object.
function checkSettings(obj, defaultObj) {
    Object.keys(defaultObj).forEach(key => {
        if (!obj.hasOwnProperty(key)) {
            obj[key] = defaultObj[key];
        } else if (defaultObj[key] && (defaultObj[key].constructor === {}.constructor)) {
            checkSettings(obj[key], defaultObj[key]);
        }
    });
}

function loadSettings() {
    const loadedSettings = $.parseJSON(localStorage.getItem(SETTINGS_STORE_NAME));
    const defaultSettings = {
        lastVersion: null,
        layers: {
            zips: { visible: true, dynamicLabels: false, junk: 123.42 },
            counties: { visible: true, dynamicLabels: true }
        }
    };
    if (loadedSettings) {
        _settings = loadedSettings;
        checkSettings(_settings, defaultSettings);
    } else {
        _settings = defaultSettings;
    }
}

function saveSettings() {
    if (localStorage) {
        _settings.lastVersion = SCRIPT_VERSION;
        _settings.layers.zips.visible = _zipsLayer.visibility;
        _settings.layers.counties.visible = _countiesLayer.visibility;
        localStorage.setItem(SETTINGS_STORE_NAME, JSON.stringify(_settings));
        log('Settings saved');
    }
}

function getUrl(baseUrl, extent, zoom, outFields) {
    const geometry = {
        xmin: extent.left,
        ymin: extent.bottom,
        xmax: extent.right,
        ymax: extent.top,
        spatialReference: { wkid: 102100, latestWkid: 3857 }
    };
    const geometryStr = JSON.stringify(geometry);
    let url = `${baseUrl}query?geometry=${encodeURIComponent(geometryStr)}`;
    url += '&returnGeometry=true';
    url += `&outFields=${encodeURIComponent(outFields.join(','))}`;
    url += '&quantizationParameters={tolerance:100}';
    url += '&spatialRel=esriSpatialRelIntersects&geometryType=esriGeometryEnvelope&inSR=102100&outSR=3857&f=json';
    return url;
}

const _zipCities = {};
function appendCityToZip(zip, cityState, context) {
    if (!context.cancel) {
        if (!cityState.error) {
            _zipCities[zip] = cityState;
            $('#zip-text').append(` (${cityState.city}, ${cityState.state})`);
        }
    }
}

function updateNameDisplay(context) {
    const center = W.map.getCenter();
    const mapCenter = new OL.Geometry.Point(center.lon, center.lat);
    const baseUrl = 'https://tools.usps.com/go/ZipLookupResultsAction!input.action?resultMode=2&companyName=&address1=&address2=&city=&state=Select&urbanCode=&postalCode=';
    let feature;
    let text = '';
    let label;
    let url;

    if (context.cancel) return;
    if (_zipsLayer && _zipsLayer.visibility) {
        const onload = res => appendCityToZip(text, $.parseJSON(res.responseText), res.context);
        for (let i = 0; i < _zipsLayer.features.length; i++) {
            feature = _zipsLayer.features[i];

            if (feature.geometry.containsPoint && feature.geometry.containsPoint(mapCenter)) {
                text = feature.attributes.name;
                url = `${baseUrl + text}&zip=`;
                $('<span>', { id: 'zip-text' }).empty().css({ display: 'inline-block' }).append(
                    $('<a>', { href: url, target: '__blank', title: 'Look up USPS zip code' })
                        .text(text)
                        .css({ color: 'white', display: 'inline-block' }),
                ).appendTo($('#zip-boundary'));
                if (!context.cancel) {
                    if (_zipCities[text]) {
                        appendCityToZip(text, _zipCities[text], context);
                    } else {
                        GM_xmlhttpRequest({
                            url: `https://wazex.us/zips/ziptocity2.php?zip=${text}`, context, method: 'GET', onload
                        });
                    }
                }
            }
        }
    }
    if (_countiesLayer && _countiesLayer.visibility) {
        for (let i = 0; i < _countiesLayer.features.length; i++) {
            feature = _countiesLayer.features[i];
            if (feature.attributes.type !== 'label' && feature.geometry.containsPoint(mapCenter)) {
                label = feature.attributes.name;
                $('<span>', { id: 'county-text' }).css({ display: 'inline-block' })
                    .text(label)
                    .appendTo($('#county-boundary'));
            }
        }
    }
}

function arcgisFeatureToOLFeature(feature, attributes) {
    const rings = [];
    feature.geometry.rings.forEach(ringIn => {
        const pnts = [];
        for (let i = 0; i < ringIn.length; i++) {
            pnts.push(new OL.Geometry.Point(ringIn[i][0], ringIn[i][1]));
        }
        rings.push(new OL.Geometry.LinearRing(pnts));
    });
    return new OL.Feature.Vector(new OL.Geometry.Polygon(rings), attributes);
}

function getRingArrayFromFeature(feature) {
    return feature.geometry.components.map(
        featureRing => featureRing.components.map(pt => [pt.x, pt.y])
    );
}

function getLabelPoints(feature) {
    const e = W.map.getExtent();
    const screenPoly = turf.polygon([[
        [e.left, e.top], [e.right, e.top], [e.right, e.bottom], [e.left, e.bottom], [e.left, e.top]
    ]]);
    // The intersect function doesn't seem to like holes in polygons, so assume the
    // first ring is the outer boundary and ignore any holes.
    const featurePoly = turf.polygon([getRingArrayFromFeature(feature)[0]]);
    const intersection = turf.intersect(screenPoly, featurePoly);
    let pts;

    if (intersection && intersection.geometry && intersection.geometry.coordinates) {
        let turfPt = turf.centerOfMass(intersection);
        if (!turf.inside(turfPt, intersection)) {
            turfPt = turf.pointOnSurface(intersection);
        }
        const turfCoords = turfPt.geometry.coordinates;
        const pt = new OL.Geometry.Point(turfCoords[0], turfCoords[1]);
        const { attributes } = feature;
        attributes.label = feature.attributes.name;
        pts = [new OL.Feature.Vector(pt, attributes)];
    } else {
        pts = null;
    }
    return pts;
}

function processBoundaries(boundaries, context, type, nameField) {
    let layer;
    let layerSettings;
    switch (type) {
        case 'zip':
            layerSettings = _settings.layers.zips;
            layer = _zipsLayer;
            break;
        case 'county':
            layerSettings = _settings.layers.counties;
            layer = _countiesLayer;
            break;
        default:
            throw new Error('USBG: Unexpected type argument in processBoundaries');
    }

    if (context.cancel || !layerSettings.visible) {
        // do nothing
    } else {
        layer.removeAllFeatures();
        if (!context.cancel) {
            boundaries.forEach(boundary => {
                const attributes = {
                    name: boundary.attributes[nameField],
                    label: layerSettings.dynamicLabels ? '' : boundary.attributes[nameField],
                    type
                };

                if (!context.cancel) {
                    const feature = arcgisFeatureToOLFeature(boundary, attributes);
                    layer.addFeatures([feature]);
                    if (layerSettings.dynamicLabels) {
                        const labels = getLabelPoints(feature);
                        if (labels) {
                            labels.forEach(labelFeature => {
                                labelFeature.attributes.type = 'label';
                            });
                            layer.addFeatures(labels);
                        }
                    }
                }
            });
        }
    }

    context.callCount--;
    if (context.callCount === 0) {
        updateNameDisplay(context);
        const idx = PROCESS_CONTEXTS.indexOf(context);
        if (idx > -1) {
            PROCESS_CONTEXTS.splice(idx, 1);
        }
    }
}
function getUspsRoutesUrl(lon, lat, radius) {
    return USPS_ROUTES_URL_TEMPLATE.replace('{lon}', lon).replace('{lat}', lat).replace('{radius}', radius);
}

function getCircleLinearRing() {
    const center = W.map.getCenter();
    const radius = USPS_ROUTES_RADIUS * 1609.344; // miles to meters
    const points = [];

    for (let degree = 0; degree < 360; degree += 5) {
        const radians = degree * Math.PI / 180;
        const lon = center.lon + radius * Math.cos(radians);
        const lat = center.lat + radius * Math.sin(radians);
        points.push(new OL.Geometry.Point(lon, lat));
    }
    return new OL.Geometry.LinearRing(points);
}

function processUspsRoutesResponse(res) {
    const data = $.parseJSON(res.responseText);
    const routes = data.results[0].value.features;

    const zipRoutes = {};
    routes.forEach(route => {
        const id = `${route.attributes.CITY_STATE} ${route.attributes.ZIP_CODE}`;
        let zipRoute = zipRoutes[id];
        if (!zipRoute) {
            zipRoute = { paths: [] };
            zipRoutes[id] = zipRoute;
        }
        zipRoute.paths = zipRoute.paths.concat(route.geometry.paths);
    });

    const features = [];
    let routeIdx = 0;

    _$resultsDiv.empty();
    Object.keys(zipRoutes).forEach(zipName => {
        const route = zipRoutes[zipName];
        const paths = route.paths.map(path => {
            const pointList = path.map(point => new OL.Geometry.Point(point[0], point[1]));
            return new OL.Geometry.LineString(pointList);
        });
        const color = USPS_ROUTE_COLORS[routeIdx];
        const style = {
            strokeColor: color,
            strokeDashstyle: 'solid',
            strokeWidth: 18
        };
        features.push(new OL.Feature.Vector(
            new OL.Geometry.MultiLineString(paths), null, style
        ));
        _$resultsDiv.append($('<div>').text(zipName).css({ color, fontWeight: 'bold' }));
        routeIdx++;
    });
    _$getRoutesButton.removeAttr('disabled').css({ color: '#000' });
    _uspsRoutesMapLayer.addFeatures(features);
}

function fetchUspsRoutesFeatures() {
    const center = W.map.getCenter();
    const url = getUspsRoutesUrl(center.lon, center.lat, USPS_ROUTES_RADIUS);

    _$getRoutesButton.attr('disabled', 'true').css({ color: '#888' });
    _$resultsDiv.empty().append('<i class="fa fa-spinner fa-pulse fa-3x fa-fw"></i>');
    _uspsRoutesMapLayer.removeAllFeatures();
    GM_xmlhttpRequest({ url, onload: processUspsRoutesResponse });
}

function fetchBoundaries() {
    if (PROCESS_CONTEXTS.length > 0) {
        PROCESS_CONTEXTS.forEach(context => { context.cancel = true; });
    }

    const extent = W.map.getExtent();
    const zoom = W.map.getZoom();
    let url;
    const context = { callCount: 0, cancel: false };
    PROCESS_CONTEXTS.push(context);
    $('.us-boundary-region').remove();
    $('.loading-indicator-region').before(
        $('<div>', { id: 'county-boundary', class: 'us-boundary-region' })
            .css({ color: 'white', float: 'left', marginLeft: '10px' }),
        $('<div>', { id: 'zip-boundary', class: 'us-boundary-region' })
            .css({ color: 'white', float: 'left', marginLeft: '10px' })
    );
    if (_settings.layers.zips.visible) {
        url = getUrl(ZIPS_LAYER_URL, extent, zoom, ['ZCTA5']);
        context.callCount++;
        $.ajax({
            url,
            context,
            method: 'GET',
            datatype: 'json',
            success(data) { processBoundaries($.parseJSON(data).features, this, 'zip', 'ZCTA5', 'ZCTA5'); }
        });
    }
    if (_settings.layers.counties.visible) {
        url = getUrl(COUNTIES_LAYER_URL, extent, zoom, ['NAME']);
        context.callCount++;
        $.ajax({
            url,
            context,
            method: 'GET',
            datatype: 'json',
            success(data) { processBoundaries($.parseJSON(data).features, this, 'county', 'NAME', 'NAME'); }
        });
    }
}

// function fetchTimeZone() {
//     let center = W.map.getCenter();
//     center.transform(W.map.projection, W.map.displayProjection);
//     let dt = new Date();
//     $.ajax({
//         url: 'https://maps.googleapis.com/maps/api/timezone/json?location=' + center.lat + ','
//              + center.lon + '&timestamp=' + (dt.getTime() / 1000),
//         method: 'GET',
//         success: function(data) {
//             console.log(data);
//         }
//     });
// }

function onZipsLayerVisibilityChanged() {
    _settings.layers.zips.visible = _zipsLayer.visibility;
    saveSettings();
    fetchBoundaries();
}
function onCountiesLayerVisibilityChanged() {
    _settings.layers.counties.visible = _countiesLayer.visibility;
    saveSettings();
    fetchBoundaries();
}

function onZipsLayerToggleChanged(checked) {
    _zipsLayer.setVisibility(checked);
}
function onCountiesLayerToggleChanged(checked) {
    _countiesLayer.setVisibility(checked);
}

function onGetRoutesButtonClick() {
    fetchUspsRoutesFeatures();
}
function onGetRoutesButtonMouseEnter() {
    _$getRoutesButton.css({ color: '#00a' });
    const style = {
        strokeColor: '#ff0',
        strokeDashstyle: 'solid',
        strokeWidth: 6,
        fillColor: '#ff0',
        fillOpacity: 0.2
    };
    _circleFeature = new OL.Feature.Vector(getCircleLinearRing(), null, style);
    _uspsRoutesMapLayer.addFeatures([_circleFeature]);
}
function onGetRoutesButtonMouseLeave() {
    _$getRoutesButton.css({ color: '#000' });
    _uspsRoutesMapLayer.removeFeatures([_circleFeature]);
}

function onClearRoutesButtonClick() {
    _uspsRoutesMapLayer.removeAllFeatures();
    _$resultsDiv.empty();
}

function showScriptInfoAlert() {
    /* Check version and alert on update */
    if (ALERT_UPDATE && SCRIPT_VERSION !== _settings.lastVersion) {
        alert(SCRIPT_VERSION_CHANGES);
    }
}

let _zipsStyle;
let _countiesStyle;
function initLayer() {
    _zipsStyle = {
        strokeColor: '#FF0000',
        strokeOpacity: 1,
        strokeWidth: 3,
        strokeDashstyle: 'solid',
        fillOpacity: 0,
        fontSize: '16px',
        fontFamily: 'Arial',
        fontWeight: 'bold',
        fontColor: 'red',
        label: '${label}',
        labelYOffset: '-20',
        labelOutlineColor: 'white',
        labelOutlineWidth: 2
    };
    _countiesStyle = {
        strokeColor: 'pink',
        strokeOpacity: 1,
        strokeWidth: 6,
        strokeDashstyle: 'solid',
        fillOpacity: 0,
        fontSize: '18px',
        fontFamily: 'Arial',
        fontWeight: 'bold',
        fontColor: 'pink',
        label: '${label}',
        labelOutlineColor: 'black',
        labelOutlineWidth: 2
    };

    _zipsLayer = new OL.Layer.Vector('US Gov\'t Boundaries - Zip Codes', {
        uniqueName: '__WMEUSBoundaries_Zips',
        styleMap: new OL.StyleMap({
            default: _zipsStyle
        })
    });
    _countiesLayer = new OL.Layer.Vector('US Gov\'t Boundaries - Counties', {
        uniqueName: '__WMEUSBoundaries_Counties',
        styleMap: new OL.StyleMap({
            default: _countiesStyle
        })
    });


    _zipsLayer.setOpacity(0.6);
    _countiesLayer.setOpacity(0.6);

    _zipsLayer.setVisibility(_settings.layers.zips.visible);
    _countiesLayer.setVisibility(_settings.layers.counties.visible);

    W.map.addLayers([_countiesLayer, _zipsLayer]);

    _zipsLayer.events.register('visibilitychanged', null, onZipsLayerVisibilityChanged);
    _countiesLayer.events.register('visibilitychanged', null, onCountiesLayerVisibilityChanged);
    W.map.events.register('moveend', W.map, () => {
        fetchBoundaries();
        // fetchTimeZone();
        return true;
    }, true);

    // Add the layer checkbox to the Layers menu.
    WazeWrap.Interface.AddLayerCheckbox('display', 'Zip Codes',
        _settings.layers.zips.visible, onZipsLayerToggleChanged);
    WazeWrap.Interface.AddLayerCheckbox('display', 'Counties',
        _settings.layers.counties.visible, onCountiesLayerToggleChanged);
}

function initTab() {
    const $content = $('<div>').append(
        $('<fieldset>', { style: 'border:1px solid silver;padding:8px;border-radius:4px;' }).append(
            $('<legend>', { style: 'margin-bottom:0px;borer-bottom-style:none;width:auto;' }).append(
                $('<h4>').text('ZIP Codes')
            ),
            $('<div>', { class: 'controls-container', style: 'padding-top:0px' }).append(
                $('<input>', { type: 'checkbox', id: 'usgb-zips-dynamicLabels' }),
                $('<label>', { for: 'usgb-zips-dynamicLabels' }).text('Dynamic label positions')
            )
        ),
        $('<fieldset>', { style: 'border:1px solid silver;padding:8px;border-radius:4px;' }).append(
            $('<legend>', { style: 'margin-bottom:0px;borer-bottom-style:none;width:auto;' }).append(
                $('<h4>').text('Counties')
            ),
            $('<div>', { class: 'controls-container', style: 'padding-top:0px' }).append(
                $('<input>', { type: 'checkbox', id: 'usgb-counties-dynamicLabels' }),
                $('<label>', { for: 'usgb-counties-dynamicLabels' }).text('Dynamic label positions')
            )
        )
    );
    new WazeWrap.Interface.Tab('USGB', $content.html(), () => {
        $('#usgb-zips-dynamicLabels').prop('checked', _settings.layers.zips.dynamicLabels).change(() => {
            _settings.layers.zips.dynamicLabels = $('#usgb-zips-dynamicLabels').is(':checked');
            saveSettings();
            fetchBoundaries();
        });
        $('#usgb-counties-dynamicLabels').prop('checked', _settings.layers.counties.dynamicLabels).change(() => {
            _settings.layers.counties.dynamicLabels = $('#usgb-counties-dynamicLabels').is(':checked');
            saveSettings();
            fetchBoundaries();
        });
    });
}

function initUspsRoutesLayer() {
    _uspsRoutesMapLayer = new OL.Layer.Vector('USPS Routes', { uniqueName: '__wmeUSPSroutes' });
    W.map.addLayer(_uspsRoutesMapLayer);

    // W.map.setLayerIndex(_uspsRoutesMapLayer, W.map.getLayerIndex(W.map.roadLayers[0])-1);
    // HACK to get around conflict with URO+.  If URO+ is fixed, this can be replaced with the setLayerIndex line above.
    _uspsRoutesMapLayer.setZIndex(334);
    const checkLayerZIndex = () => { if (_uspsRoutesMapLayer.getZIndex() !== 334) _uspsRoutesMapLayer.setZIndex(334); };
    setInterval(checkLayerZIndex, 100);
    // END HACK

    _uspsRoutesMapLayer.setOpacity(0.8);
}

function init() {
    loadSettings();

    initLayer();
    initTab();
    showScriptInfoAlert();
    fetchBoundaries();

    initUspsRoutesLayer();
    _$resultsDiv = $('<div>', { id: 'usps-route-results', style: 'margin-top:3px;' });
    _$getRoutesButton = $('<button>', { id: 'get-usps-routes', style: 'height:23px;' }).text('Get USPS routes');
    $('#sidebar').prepend(
        $('<div>', { style: 'margin-left:10px;' }).append(
            _$getRoutesButton
                .click(onGetRoutesButtonClick)
                .mouseenter(onGetRoutesButtonMouseEnter)
                .mouseout(onGetRoutesButtonMouseLeave),
            $('<button>', { id: 'clear-usps-routes', style: 'height:23px; margin-left:4px;' })
                .text('Clear')
                .click(onClearRoutesButtonClick),
            _$resultsDiv
        )
    );

    log('Initialized.');
}

function bootstrap(tries = 1) {
    if (W && W.loginManager && W.loginManager.events && W.loginManager.events.register
        && W.model && W.model.states && W.model.states.additionalInfo && W.map
        && W.loginManager.user && WazeWrap.Ready) {
        log('Initializing...');
        init();
    } else {
        if (tries % 20 === 0) log('Bootstrap failed. Trying again...');
        setTimeout(() => bootstrap(++tries), 250);
    }
}

log('Bootstrap...');
bootstrap();
