// ==UserScript==
// @name            WME US Government Boundaries
// @namespace       https://greasyfork.org/users/45389
// @version         2026.02.15.000
// @description     Adds a layer to display US (federal, state, and/or local) boundaries.
// @author          MapOMatic
// @include         /^https:\/\/(www|beta)\.waze\.com\/(?!user\/)(.{2,6}\/)?editor\/?.*$/
// @require         https://cdn.jsdelivr.net/npm/@turf/turf@7/turf.min.js
// @require         https://greasyfork.org/scripts/24851-wazewrap/code/WazeWrap.js
// @require         https://update.greasyfork.org/scripts/509664/WME%20Utils%20-%20Bootstrap.js
// @grant           GM_xmlhttpRequest
// @license         GNU GPLv3
// @contributionURL https://github.com/WazeDev/Thank-The-Authors
// @connect         census.gov
// @connect         wazex.us
// @connect         usps.com
// @connect         arcgis.com
// @connect         greasyfork.org
// ==/UserScript==

/* global turf */
/* global WazeWrap */
/* global bootstrap */

(async function main() {
  'use strict';

  const UPDATE_MESSAGE = 'When you click on the Zip code, you no longer have to type it in the USPS window.';
  const downloadUrl = 'https://greasyfork.org/scripts/25631-wme-us-government-boundaries/code/WME%20US%20Government%20Boundaries.user.js';

  const SETTINGS_STORE_NAME = 'wme_us_government_boundaries';
  const ZIPS_LAYER_URL = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer/2/';
  const COUNTIES_LAYER_URL = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer/82/';
  const STATES_LAYER_URL = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer/80/';
  const TIME_ZONES_LAYER_URL = 'https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/World_Time_Zones/FeatureServer/0/';
  const USPS_ROUTE_COLORS = ['#f00', '#0a0', '#00f', '#a0a', '#6c82cb', '#0aa'];
  const USPS_ROUTES_URL_TEMPLATE =
    'https://gis.usps.com/arcgis/rest/services/EDDM/selectNear/GPServer/routes/execute?f=json&env%3AoutSR=4326&' +
    'Selecting_Features=%7B%22geometryType%22%3A%22esriGeometryPoint%22%2C%22features%22%3A%5B%7B%22' +
    'geometry%22%3A%7B%22x%22%3A{lon}%2C%22y%22%3A{lat}%2C%22spatialReference%22%3A%7B%22wkid%22%3A' +
    '4326%7D%7D%7D%5D%2C%22sr%22%3A%7B%22wkid%22%3A4326%7D%7D&Distance={radius}&Rte_Box=R&userName=EDDM';

  function getMaxAllowableOffsetForZoom(zoomLevel) {
    const zoomToOffsetMap = {
      4: 0.057,
      5: 0.057,
      6: 0.057,
      7: 0.0285,
      8: 0.0142,
      9: 0.0072,
      10: 0.0036,
      11: 0.0018,
      12: 0.0009,
      13: 0.00045,
      14: 0.000225,
      15: 0.0001125,
      16: 0.000056,
      17: 0.000028,
      18: 0.000014,
      19: 0.000007,
      20: 0.000007,
      21: 0.000007,
      22: 0.000007,
    };
    const key = Math.round(zoomLevel);
    return zoomToOffsetMap[key] !== undefined ? zoomToOffsetMap[key] : zoomToOffsetMap[22];
  }

  const PROCESS_CONTEXTS = [];
  const ZIP_CITIES = {};
  let _activeRequests = [];
  const sdk = await bootstrap({ scriptUpdateMonitor: { downloadUrl } });
  const ZIPS_LAYER_NAME = "US Gov't Boundaries - Zip Codes";
  const COUNTIES_LAYER_NAME = "US Gov't Boundaries - Counties";
  const STATES_LAYER_NAME = "US Gov't Boundaries - States";
  const TIME_ZONES_LAYER_NAME = "US Gov't Boundaries - Time Zones";
  const USPS_ROUTES_LAYER_NAME = 'USPS Routes';

  const zipsLayerCheckboxName = 'USGB - Zip codes';
  const countiesLayerCheckboxName = 'USGB - Counties';
  const statesLayerCheckboxName = 'USGB - States';
  const timeZonesLayerCheckboxName = 'USGB - Time zones';
  let _$uspsResultsDiv;
  let _$getRoutesButton;
  let _settings = {};
  let _fetchBoundariesTimeout;
  let _uspsRoutesActive = false;
  let _cachedScreenPolygon = null;
  let _cachedScreenArea = null;
  let _cachedExtent = null;
  let _cachedClipPolygon = null;

  function log(message) {
    console.log('USGB:', message);
  }
  function logDebug(message) {
    console.log('USGB:', message);
  }
  function logError(message) {
    console.error('USGB:', message);
  }

  function getDefaultSettings() {
    return {
      lastVersion: GM_info.script.version,
      layers: {
        zips: {
          visible: true,
          dynamicLabels: true,
          color: '#ff0000',
          labelOutlineColor: '#ffffff',
          opacity: 0.6,
          minZoom: 12,
        },
        counties: {
          visible: true,
          dynamicLabels: true,
          color: '#ffc0cb',
          labelOutlineColor: '#000000',
          opacity: 0.6,
          minZoom: 8,
        },
        states: {
          visible: true,
          dynamicLabels: true,
          color: '#0000ff',
          labelOutlineColor: '#add8e6',
          opacity: 0.6,
        },
        timeZones: {
          visible: true,
          dynamicLabels: true,
          color: '#ff8855',
          labelOutlineColor: '#883311',
          opacity: 0.6,
        },
      },
      uspsRoutes: {
        radius: 0.5,
        opacity: 0.8,
      },
    };
  }

  function checkSettings(obj, defaultObj) {
    Object.keys(defaultObj).forEach((key) => {
      if (!obj.hasOwnProperty(key)) {
        obj[key] = defaultObj[key];
      } else if (defaultObj[key] && defaultObj[key].constructor === {}.constructor) {
        checkSettings(obj[key], defaultObj[key]);
      }
    });
  }

  function loadSettings() {
    const loadedSettings = $.parseJSON(localStorage.getItem(SETTINGS_STORE_NAME));
    const defaultSettings = getDefaultSettings();
    if (loadedSettings) {
      _settings = loadedSettings;
      checkSettings(_settings, defaultSettings);
    } else {
      _settings = defaultSettings;
    }
  }

  function saveSettings() {
    if (localStorage) {
      localStorage.setItem(SETTINGS_STORE_NAME, JSON.stringify(_settings));
      log('Settings saved');
    }
  }

  function ensurePolygonCaches() {
    const ext = sdk.Map.getMapExtent();

    // Check if cache is valid
    if (
      _cachedExtent &&
      _cachedScreenPolygon &&
      _cachedScreenArea !== null &&
      _cachedClipPolygon &&
      _cachedExtent[0] === ext[0] &&
      _cachedExtent[1] === ext[1] &&
      _cachedExtent[2] === ext[2] &&
      _cachedExtent[3] === ext[3]
    ) {
      return; // Cache is valid
    }

    // Cache miss - create both polygons and calculate screen area
    _cachedExtent = ext;

    // Create screen polygon
    _cachedScreenPolygon = turf.polygon([
      [
        [ext[0], ext[3]],
        [ext[2], ext[3]],
        [ext[2], ext[1]],
        [ext[0], ext[1]],
        [ext[0], ext[3]],
      ],
    ]);

    // Calculate and cache screen area
    _cachedScreenArea = turf.area(_cachedScreenPolygon);

    // Create expanded clip polygon
    const width = ext[2] - ext[0];
    const height = ext[3] - ext[1];
    const expandBy = 2;
    const clipBox = [ext[0] - width * expandBy, ext[1] - height * expandBy, ext[2] + width * expandBy, ext[3] + height * expandBy];
    _cachedClipPolygon = turf.bboxPolygon(clipBox);
  }
  
  function getScreenPolygon() {
    ensurePolygonCaches();
    return _cachedScreenPolygon;
  }

  function getScreenArea() {
    ensurePolygonCaches();
    return _cachedScreenArea;
  }

  function getClipPolygon() {
    ensurePolygonCaches();
    return _cachedClipPolygon;
  }

  function getUrl(baseUrl, extent, zoom, outFields, fParam = 'json') {
    const geometry = {
      xmin: extent[0],
      ymin: extent[1],
      xmax: extent[2],
      ymax: extent[3],
      spatialReference: { wkid: 4326 },
    };
    const geometryStr = encodeURIComponent(JSON.stringify(geometry));
    const maxAllowableOffsetDeg = getMaxAllowableOffsetForZoom(zoom);

    let url = `${baseUrl}query?geometry=${geometryStr}`;
    url += '&returnGeometry=true';
    url += `&outFields=${encodeURIComponent(outFields.join(','))}`;
    url += `&maxAllowableOffset=${maxAllowableOffsetDeg}`;
    url += '&spatialRel=esriSpatialRelIntersects';
    url += '&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326';
    url += `&f=${fParam}`;
    return url;
  }

  function appendCityToZip(zip, cityState, context) {
    if (!context.cancel) {
      if (!cityState.error) {
        ZIP_CITIES[zip] = cityState;
        $('#zip-text').append(` (${cityState.city}, ${cityState.state})`);
      }
    }
  }

  let lastZipFeatures;
  let lastCountyFeatures;

  function updateNameDisplay(context) {
    const center = sdk.Map.getMapCenter();
    const mapCenter = turf.point([center.lon, center.lat]);
    let text = '';
    let label;

    if (context.cancel) return;
    if (_settings.layers.zips.visible) {
      const onload = (res) => appendCityToZip(text, $.parseJSON(res.responseText), res.context);
      for (let i = 0; i < lastZipFeatures.length; i++) {
        const feature = lastZipFeatures[i];

        // Quick bounding box check before expensive point-in-polygon
        const bbox = turf.bbox(feature);
        if (center.lon < bbox[0] || center.lon > bbox[2] || center.lat < bbox[1] || center.lat > bbox[3]) {
          continue;
        }

        if (turf.booleanPointInPolygon(mapCenter, feature)) {
          text = feature.properties.name.substr(1);
          $('<span>', { id: 'zip-text' })
            .empty()
            .css({ display: 'inline-block' })
            .append(
              $('<a>', { href: `https://tools.usps.com/zip-code-lookup.htm?citybyzipcode&mode=byZip&zip=${text}`, target: '__blank', title: 'Look up USPS zip code' })
                .text(text)
                .css({ color: 'white', display: 'inline-block', cursor: 'pointer', 'text-decoration': 'underline' }),
            )
            .appendTo($('#zip-boundary'));
          if (!context.cancel) {
            if (ZIP_CITIES[text]) {
              appendCityToZip(text, ZIP_CITIES[text], context);
            } else {
              GM_xmlhttpRequest({
                url: `https://wazex.us/zips/ziptocity2.php?zip=${text}`,
                context,
                method: 'GET',
                onload,
              });
            }
          }
        }
      }
    }
    if (_settings.layers.counties.visible) {
      for (let i = 0; i < lastCountyFeatures.length; i++) {
        const feature = lastCountyFeatures[i];

        // Quick bounding box check before expensive point-in-polygon
        const bbox = turf.bbox(feature);
        if (center.lon < bbox[0] || center.lon > bbox[2] || center.lat < bbox[1] || center.lat > bbox[3]) {
          continue;
        }

        if (turf.booleanPointInPolygon(mapCenter, feature)) {
          label = feature.properties.name;
          $('<span>', { id: 'county-text' }).css({ display: 'inline-block' }).text(label).appendTo($('#county-boundary'));
        }
      }
    }
  }

  function extractPolygonsWithExternalRings(boundary, attributes) {
    const coordinates = boundary.geometry.rings;
    const externalPolygons = [];

    const clipPolygon = getClipPolygon();

    let mainOuterPolygon = turf.polygon([coordinates[0]], attributes);
    mainOuterPolygon.id = 0;

    for (let i = 1; i < coordinates.length; i++) {
      const testPolygon = turf.polygon([coordinates[i]]);
      if (turf.booleanContains(mainOuterPolygon, testPolygon)) {
        const differenceResult = turf.difference(turf.featureCollection([mainOuterPolygon, testPolygon]));
        if (differenceResult) {
          mainOuterPolygon = differenceResult;
          mainOuterPolygon.id = 0;
        } else {
          // Difference resulted in null - the hole consumed the entire polygon
          // Skip this polygon entirely by setting mainOuterPolygon to null
          mainOuterPolygon = null;
          break;
        }
      } else {
        testPolygon.properties = attributes;
        externalPolygons.push(testPolygon);
      }
    }

    const clippedPolygons = [];
    const polygonsToClip = mainOuterPolygon ? [mainOuterPolygon, ...externalPolygons] : externalPolygons;

    polygonsToClip.forEach((polygon) => {
      if (!polygon) return; // Skip null polygons

      const clippedFeature = turf.intersect(turf.featureCollection([polygon, clipPolygon]));
      if (clippedFeature) {
        switch (clippedFeature.geometry.type) {
          case 'Polygon':
            clippedPolygons.push(clippedFeature);
            break;
          case 'MultiPolygon':
            clippedFeature.geometry.coordinates.forEach((ring) => clippedPolygons.push(turf.polygon(ring)));
            break;
          default:
            throw new Error('Unexpected feature type');
        }
      }
    });

    clippedPolygons
      .filter((polygon) => polygon.geometry.coordinates.length)
      .forEach((polygon) => {
        polygon.id = 0;
        polygon.properties = attributes;
      });

    return clippedPolygons;
  }

  function getLabelPoints(feature) {
    const screenPolygon = getScreenPolygon();
    const intersection = turf.intersect(turf.featureCollection([screenPolygon, feature]));
    const polygons = [];
    if (intersection) {
      switch (intersection.geometry.type) {
        case 'Polygon':
          polygons.push(intersection);
          break;
        case 'MultiPolygon':
          intersection.geometry.coordinates.forEach((ring) => polygons.push(turf.polygon(ring)));
          break;
        default:
          throw new Error('Unexpected geometry type');
      }
    }

    const screenArea = getScreenArea();
    const points = polygons
      .filter((polygon) => {
        const polygonArea = turf.area(polygon);
        return polygonArea / screenArea > 0.005;
      })
      .map((polygon) => {
        let point = turf.centerOfMass(polygon);
        if (!turf.booleanPointInPolygon(point, polygon)) {
          point = turf.pointOnFeature(polygon);
        }
        point.properties = { type: 'label', label: feature.properties.name };
        point.id = 0;
        return point;
      });
    return points;
  }

  let pointCount;
  let reducedPointCount;

  function processBoundaries(boundaries, context, type, nameField) {
    let layerName;
    let layerSettings;

    pointCount = 0;
    reducedPointCount = 0;
    switch (type) {
      case 'zip':
        layerSettings = _settings.layers.zips;
        layerName = ZIPS_LAYER_NAME;
        boundaries.forEach((boundary) => {
          boundary.attributes[nameField] = `\u200D${boundary.attributes[nameField]}`;
        });
        break;
      case 'county':
        layerSettings = _settings.layers.counties;
        layerName = COUNTIES_LAYER_NAME;
        break;
      case 'state':
        layerSettings = _settings.layers.states;
        layerName = STATES_LAYER_NAME;
        layerSettings.dynamicLabels = true;
        break;
      case 'timeZone':
        layerSettings = _settings.layers.timeZones;
        layerName = TIME_ZONES_LAYER_NAME;
        boundaries.forEach((boundary) => {
          let zone = boundary.attributes[nameField];
          if (zone >= 0) zone = `+${zone}`;
          boundary.attributes[nameField] = `UTC${zone}`;
        });
        break;
      default:
        throw new Error('USGB: Unexpected type argument in processBoundaries');
    }

    const allFeatures = [];
    if (context.cancel || !layerSettings.visible) {
      // do nothing
    } else {
      const screenArea = getScreenArea();
      sdk.Map.removeAllFeaturesFromLayer({ layerName });

      // Collect all polygons and labels before adding to map
      const allPolygons = [];
      const allLabels = [];

      if (!context.cancel) {
        boundaries.forEach((boundary) => {
          if (context.cancel) return;

          const attributes = {
            name: boundary.attributes[nameField],
            label: boundary.attributes[nameField],
            type,
          };

          const features = extractPolygonsWithExternalRings(boundary, attributes);
          if (features.length) {
            if (type === 'zip' || type === 'county') {
              allFeatures.push(...features);
            }

            features.forEach((polygon) => {
              if (layerSettings.dynamicLabels) {
                polygon.properties.label = '';
              } else {
                const polygonArea = turf.area(polygon);
                if (polygonArea / screenArea <= 0.005) {
                  polygon.properties.label = '';
                }
              }
            });

            // Collect polygons instead of adding immediately
            allPolygons.push(...features);

            // Collect labels if using dynamic labels
            if (layerSettings.dynamicLabels) {
              features.forEach((feature) => {
                const labels = getLabelPoints(feature);
                if (labels?.length) {
                  allLabels.push(...labels);
                }
              });
            }
          }
        });

        // Add all polygons at once
        if (allPolygons.length && !context.cancel) {
          try {
            sdk.Map.addFeaturesToLayer({ layerName, features: allPolygons });
          } catch (ex) {
            logError('FAIL adding polygons: ', ex);
          }
        }

        // Add all labels at once
        if (allLabels.length && !context.cancel) {
          try {
            sdk.Map.addFeaturesToLayer({ layerName, features: allLabels });
          } catch (ex) {
            logError('FAIL adding labels: ', ex);
          }
        }
      }
    }

    if (type === 'zip') {
      lastZipFeatures = allFeatures;
    } else if (type === 'county') {
      lastCountyFeatures = allFeatures;
    }

    context.callCount--;
    if (context.callCount === 0) {
      updateNameDisplay(context);
      const idx = PROCESS_CONTEXTS.indexOf(context);
      if (idx > -1) {
        PROCESS_CONTEXTS.splice(idx, 1);
      }
    }

    if (sdk.State.getUserInfo().userName === 'MapOMatic' || sdk.State.getUserInfo().userName === 'JS55CT') {
      logDebug(`${type} points: ${pointCount} -> ${reducedPointCount} (${((1.0 - reducedPointCount / pointCount) * 100).toFixed(1)}%)`);
    }
  }

  function getUspsRoutesUrl(lon, lat, radius) {
    return USPS_ROUTES_URL_TEMPLATE.replace('{lon}', lon).replace('{lat}', lat).replace('{radius}', radius);
  }

  function getUspsCircleFeature() {
    let center = sdk.Map.getMapCenter();
    center = [center.lon, center.lat];
    const radius = _settings.uspsRoutes.radius;
    const options = { steps: 72, units: 'miles', properties: { type: 'circle' } };
    return turf.circle(center, radius, options);
  }

  function processUspsRoutesResponse(res) {
    const data = $.parseJSON(res.responseText);
    const routes = data.results[0].value.features;

    const zipRoutes = {};
    routes.forEach((route) => {
      const id = `${route.attributes.CITY_STATE} ${route.attributes.ZIP_CODE}`;
      let zipRoute = zipRoutes[id];
      if (!zipRoute) {
        zipRoute = { paths: [] };
        zipRoutes[id] = zipRoute;
      }
      zipRoute.paths = zipRoute.paths.concat(route.geometry.paths);
    });

    const features = [];
    _$uspsResultsDiv.empty();

    const routeCount = Object.keys(zipRoutes).length;
    Object.keys(zipRoutes).forEach((zipName, routeIdx) => {
      const route = zipRoutes[zipName];
      const color = USPS_ROUTE_COLORS[routeIdx];
      const feature = turf.multiLineString(route.paths, { type: 'route', color, zIndex: routeCount - routeIdx - 1 });

      const lineStrings = feature.geometry.coordinates.map((coords) => {
        const ls = turf.lineString(coords, { type: 'route', color, zIndex: routeCount - routeIdx - 1 });
        ls.id = 'route';
        return ls;
      });
      features.push(...lineStrings);

      _$uspsResultsDiv.append($('<div>').text(zipName).css({ color, fontWeight: 'bold' }));
      routeIdx++;
    });
    _$getRoutesButton.removeAttr('disabled').css({ color: '#000' });
    sdk.Map.addFeaturesToLayer({ layerName: USPS_ROUTES_LAYER_NAME, features });
  }

  function fetchUspsRoutesFeatures() {
    const centerLonLat = sdk.Map.getMapCenter();
    const url = getUspsRoutesUrl(centerLonLat.lon, centerLonLat.lat, _settings.uspsRoutes.radius);

    _$getRoutesButton.attr('disabled', 'true').css({ color: '#888' });
    _$uspsResultsDiv.empty().append('<i class="fa fa-spinner fa-pulse fa-3x fa-fw"></i>');
    sdk.Map.removeAllFeaturesFromLayer({ layerName: USPS_ROUTES_LAYER_NAME });
    _uspsRoutesActive = true; // Set flag
    ensureUspsRoutesZIndex();
    GM_xmlhttpRequest({ url, onload: processUspsRoutesResponse, anonymous: true });
  }

  function fetchBoundaries() {
    // Cancel any in-flight requests
    if (PROCESS_CONTEXTS.length > 0) {
      PROCESS_CONTEXTS.forEach((context) => {
        context.cancel = true;
      });
    }

    // Abort active AJAX requests
    _activeRequests.forEach((request) => {
      if (request && request.abort) {
        request.abort();
      }
    });
    _activeRequests = [];

    const extent = sdk.Map.getMapExtent();
    const zoom = sdk.Map.getZoomLevel();
    let url;
    const context = { callCount: 0, cancel: false };
    PROCESS_CONTEXTS.push(context);
    $('.us-boundary-region').remove();
    $('.location-info-region').after(
      $('<div>', { id: 'county-boundary', class: 'us-boundary-region' }).css({ color: 'white', float: 'left', marginLeft: '10px' }),
      $('<div>', { id: 'zip-boundary', class: 'us-boundary-region' }).css({ color: 'white', float: 'left', marginLeft: '10px' }),
    );

    if (_settings.layers.zips.visible) {
      if (zoom >= _settings.layers.zips.minZoom) {
        url = getUrl(ZIPS_LAYER_URL, extent, zoom, ['ZCTA5']);
        context.callCount++;
        const request = $.ajax({
          url,
          context,
          method: 'GET',
          datatype: 'json',
          success(data) {
            if (data.error) {
              logError(`ZIP codes layer: ${data.error.message}`);
            } else {
              processBoundaries(data.features, this, 'zip', 'ZCTA5');
            }
          },
        });
        _activeRequests.push(request);
      } else {
        processBoundaries([], context, 'zip', 'ZCTA5');
      }
    }
    if (_settings.layers.counties.visible) {
      if (zoom >= _settings.layers.counties.minZoom) {
        url = getUrl(COUNTIES_LAYER_URL, extent, zoom, ['NAME']);
        context.callCount++;
        const request = $.ajax({
          url,
          context,
          method: 'GET',
          datatype: 'json',
          success(data) {
            if (data.error) {
              logError(`counties layer: ${data.error.message}`);
            } else {
              processBoundaries(data.features, this, 'county', 'NAME');
            }
          },
        });
        _activeRequests.push(request);
      } else {
        processBoundaries([], context, 'county', 'NAME');
      }
    }
    if (_settings.layers.timeZones.visible) {
      url = getUrl(TIME_ZONES_LAYER_URL, extent, zoom, ['ZONE']);
      context.callCount++;
      const request = $.ajax({
        url,
        context,
        method: 'GET',
        datatype: 'json',
        success(data) {
          if (data.error) {
            logError(`timezones layer: ${data.error.message}`);
          } else {
            processBoundaries(data.features, this, 'timeZone', 'ZONE');
          }
        },
      });
      _activeRequests.push(request);
    }
    if (_settings.layers.states.visible) {
      url = getUrl(STATES_LAYER_URL, extent, zoom, ['NAME']);
      context.callCount++;
      const request = $.ajax({
        url,
        context,
        method: 'GET',
        datatype: 'json',
        success(data) {
          if (data.error) {
            logError(`states layer: ${data.error.message}`);
          } else {
            processBoundaries(data.features, this, 'state', 'NAME');
          }
        },
      });
      _activeRequests.push(request);
    }
  }

  function onLayerCheckboxToggled(args) {
    let layerName;
    let settingsObj;
    switch (args.name) {
      case zipsLayerCheckboxName:
        layerName = ZIPS_LAYER_NAME;
        settingsObj = _settings.layers.zips;
        break;
      case countiesLayerCheckboxName:
        layerName = COUNTIES_LAYER_NAME;
        settingsObj = _settings.layers.counties;
        break;
      case statesLayerCheckboxName:
        layerName = STATES_LAYER_NAME;
        settingsObj = _settings.layers.states;
        break;
      case timeZonesLayerCheckboxName:
        layerName = TIME_ZONES_LAYER_NAME;
        settingsObj = _settings.layers.timeZones;
        break;
      default:
        throw new Error('Unexpected layer switcher checkbox name.');
    }
    const visibility = args.checked;
    settingsObj.visible = visibility;
    saveSettings();
    sdk.Map.setLayerVisibility({ layerName, visibility });
    fetchBoundaries();
  }

  function onGetRoutesButtonClick() {
    fetchUspsRoutesFeatures();
  }

  function onGetRoutesButtonMouseEnter() {
    _$getRoutesButton.css({ color: '#00a' });
    const feature = getUspsCircleFeature();
    feature.id = 'uspsCircle';
    sdk.Map.addFeatureToLayer({ layerName: USPS_ROUTES_LAYER_NAME, feature });
  }

  function onGetRoutesButtonMouseLeave() {
    _$getRoutesButton.css({ color: '#000' });
    sdk.Map.removeFeatureFromLayer({ layerName: USPS_ROUTES_LAYER_NAME, featureId: 'uspsCircle' });
  }

  function onClearRoutesButtonClick() {
    sdk.Map.removeAllFeaturesFromLayer({ layerName: USPS_ROUTES_LAYER_NAME });
    _$uspsResultsDiv.empty();
    _uspsRoutesActive = false; // Clear flag
  }

  function debouncedFetchBoundaries(delay = 250) {
    clearTimeout(_fetchBoundariesTimeout);
    _fetchBoundariesTimeout = setTimeout(() => {
      fetchBoundaries();
    }, delay);
  }

  const ensureUspsRoutesZIndex = () => {
    if (!_uspsRoutesActive) return; // Skip if no routes displayed

    const roadsZIndex = sdk.Map.getLayerZIndex({ layerName: 'roads' });
    const targetZIndex = roadsZIndex - 2;
    const currentZIndex = sdk.Map.getLayerZIndex({ layerName: USPS_ROUTES_LAYER_NAME });
    if (currentZIndex !== targetZIndex) {
      sdk.Map.setLayerZIndex({ layerName: USPS_ROUTES_LAYER_NAME, zIndex: targetZIndex });
    }
  };

  function onMapMoveEnd() {
    try {
      debouncedFetchBoundaries();
    } catch (e) {
      logError(e);
    }
  }

  function showScriptInfoAlert() {
    WazeWrap.Interface.ShowScriptUpdate(GM_info.script.name, GM_info.script.version, UPDATE_MESSAGE, '', 'https://www.waze.com/discuss/t/115019');
  }

  function initCountiesLayer() {
    sdk.Map.addLayer({
      layerName: COUNTIES_LAYER_NAME,
      styleContext: {
        getLabel: ({ feature, zoomLevel }) => {
          const rawLabel = feature?.properties?.label ?? '';
          if (zoomLevel <= 9) return rawLabel.replace(/\s(County|Parish)$/, '');
          return rawLabel;
        },
        getFontSize: ({ zoomLevel }) => `${Math.round(14 + (zoomLevel - 4) * 0.5)}px`,
        getStrokeWidth: ({ zoomLevel }) => Math.round(2 + (zoomLevel - 4) * 0.33),
        getStrokeColor: () => _settings.layers.counties.color,
        getFontColor: () => _settings.layers.counties.color,
        getLabelOutlineColor: () => _settings.layers.counties.labelOutlineColor,
      },
      styleRules: [
        {
          style: {
            strokeColor: '${getStrokeColor}',
            strokeOpacity: 1,
            strokeWidth: '${getStrokeWidth}',
            strokeDashstyle: 'solid',
            fillOpacity: 0,
            pointRadius: 0,
            label: '${getLabel}',
            fontSize: '${getFontSize}',
            fontFamily: 'Arial',
            fontWeight: 'bold',
            fontColor: '${getFontColor}',
            labelOutlineColor: '${getLabelOutlineColor}',
            labelOutlineWidth: 2,
          },
        },
      ],
    });
  }

  function initStatesLayer() {
    sdk.Map.addLayer({
      layerName: STATES_LAYER_NAME,
      styleContext: {
        getStrokeWidth: ({ zoomLevel }) => Math.round(1 + (zoomLevel - 4) * 0.29),
        getFontSize: ({ zoomLevel }) => `${Math.round(12 + (zoomLevel - 4) * 0.67)}px`,
        getLabelYOffset: ({ zoomLevel }) => {
          if (zoomLevel < 10) return 0;
          if (zoomLevel < 18) return 10;
          return 20;
        },
        getLabel: ({ feature, zoomLevel }) => {
          if (zoomLevel < 5) return '';
          if (zoomLevel > 21) return '';
          return feature?.properties?.label ?? '';
        },
        getStrokeColor: () => _settings.layers.states.color,
        getFontColor: () => _settings.layers.states.color,
        getLabelOutlineColor: () => _settings.layers.states.labelOutlineColor,
      },
      styleRules: [
        {
          predicate: (properties) => properties.type === 'label',
          style: {
            pointRadius: 0,
            fontSize: '${getFontSize}',
            fontFamily: 'Arial',
            fontWeight: 'bold',
            fontColor: '${getFontColor}',
            label: '${getLabel}',
            labelYOffset: '${getLabelYOffset}',
            labelOutlineColor: '${getLabelOutlineColor}',
            labelOutlineWidth: 2,
          },
        },
        {
          predicate: (properties) => properties.type === 'state',
          style: {
            strokeColor: '${getStrokeColor}',
            strokeOpacity: 1,
            strokeWidth: '${getStrokeWidth}',
            strokeDashstyle: 'solid',
            fillOpacity: 0,
          },
        },
      ],
    });
  }

  function initZipsLayer() {
    sdk.Map.addLayer({
      layerName: ZIPS_LAYER_NAME,
      styleContext: {
        getLabel: ({ feature }) => feature?.properties?.label ?? '',
        getStrokeWidth: ({ zoomLevel }) => Math.round(1 + (zoomLevel - 4) * 0.29),
        getFontSize: ({ zoomLevel }) => `${Math.round(12 + (zoomLevel - 4) * 0.67)}px`,
        getStrokeColor: () => _settings.layers.zips.color,
        getFontColor: () => _settings.layers.zips.color,
        getLabelOutlineColor: () => _settings.layers.zips.labelOutlineColor,
      },
      styleRules: [
        {
          style: {
            pointRadius: 0,
            strokeColor: '${getStrokeColor}',
            strokeOpacity: 1,
            strokeWidth: '${getStrokeWidth}',
            strokeDashstyle: 'solid',
            fillOpacity: 0,
            fontSize: '${getFontSize}',
            fontFamily: 'Arial',
            fontWeight: 'bold',
            fontColor: '${getFontColor}',
            label: '${getLabel}',
            labelYOffset: -20,
            labelOutlineColor: '${getLabelOutlineColor}',
            labelOutlineWidth: 2,
          },
        },
      ],
    });
  }

  function initTimeZonesLayer() {
    sdk.Map.addLayer({
      layerName: TIME_ZONES_LAYER_NAME,
      styleContext: {
        getLabel: (context) => context.feature.properties.label,
        getStrokeColor: () => _settings.layers.timeZones.color,
        getFontColor: () => _settings.layers.timeZones.color,
        getLabelOutlineColor: () => _settings.layers.timeZones.labelOutlineColor,
      },
      styleRules: [
        {
          style: {
            pointRadius: 0,
            strokeColor: '${getStrokeColor}',
            strokeOpacity: 1,
            strokeWidth: 6,
            strokeDashstyle: 'solid',
            fillOpacity: 0,
            fontSize: '18px',
            fontFamily: 'Arial',
            fontWeight: 'bold',
            fontColor: '${getFontColor}',
            label: '${getLabel}',
            labelYOffset: -40,
            labelOutlineColor: '${getLabelOutlineColor}',
            labelOutlineWidth: 2,
          },
        },
      ],
    });
  }

  function initLayers() {
    initZipsLayer();
    initCountiesLayer();
    initStatesLayer();
    initTimeZonesLayer();

    sdk.Map.addLayer({
      layerName: USPS_ROUTES_LAYER_NAME,
      styleContext: {
        getStrokeWidth: (context) => {
          const zoom = sdk.Map.getZoomLevel();
          let width = zoom < 3 ? 10 + 2 * zoom : 16;
          width += context.feature.properties.zIndex * 6;
          return width;
        },
        getStrokeColor: (context) => context.feature.properties.color,
      },
      styleRules: [
        {
          predicate: (properties) => properties.type === 'route',
          style: { strokeWidth: '${getStrokeWidth}', strokeColor: '${getStrokeColor}' },
        },
        {
          predicate: (properties) => properties.type === 'circle',
          style: { strokeWidth: 6, strokeColor: '#ff0', fillColor: '#ff0', fillOpacity: 0.2 },
        },
      ],
    });

    sdk.Map.setLayerOpacity({ layerName: ZIPS_LAYER_NAME, opacity: _settings.layers.zips.opacity });
    sdk.Map.setLayerOpacity({ layerName: COUNTIES_LAYER_NAME, opacity: _settings.layers.counties.opacity });
    sdk.Map.setLayerOpacity({ layerName: STATES_LAYER_NAME, opacity: _settings.layers.states.opacity });
    sdk.Map.setLayerOpacity({ layerName: TIME_ZONES_LAYER_NAME, opacity: _settings.layers.timeZones.opacity });
    sdk.Map.setLayerOpacity({ layerName: USPS_ROUTES_LAYER_NAME, opacity: _settings.uspsRoutes.opacity });

    sdk.Map.setLayerVisibility({ layerName: ZIPS_LAYER_NAME, visibility: _settings.layers.zips.visible });
    sdk.Map.setLayerVisibility({ layerName: COUNTIES_LAYER_NAME, visibility: _settings.layers.counties.visible });
    sdk.Map.setLayerVisibility({ layerName: STATES_LAYER_NAME, visibility: _settings.layers.states.visible });
    sdk.Map.setLayerVisibility({ layerName: TIME_ZONES_LAYER_NAME, visibility: _settings.layers.timeZones.visible });

    // Check z-index only when layers change and routes are active
    sdk.Events.on({ eventName: 'wme-map-layer-added', eventHandler: ensureUspsRoutesZIndex });
    sdk.Events.on({ eventName: 'wme-map-layer-changed', eventHandler: ensureUspsRoutesZIndex });
    sdk.Events.on({ eventName: 'wme-map-layer-removed', eventHandler: ensureUspsRoutesZIndex });

    sdk.LayerSwitcher.addLayerCheckbox({ name: statesLayerCheckboxName });
    sdk.LayerSwitcher.setLayerCheckboxChecked({ name: statesLayerCheckboxName, isChecked: _settings.layers.states.visible });
    sdk.LayerSwitcher.addLayerCheckbox({ name: countiesLayerCheckboxName });
    sdk.LayerSwitcher.setLayerCheckboxChecked({ name: countiesLayerCheckboxName, isChecked: _settings.layers.counties.visible });
    sdk.LayerSwitcher.addLayerCheckbox({ name: zipsLayerCheckboxName });
    sdk.LayerSwitcher.setLayerCheckboxChecked({ name: zipsLayerCheckboxName, isChecked: _settings.layers.zips.visible });
    sdk.LayerSwitcher.addLayerCheckbox({ name: timeZonesLayerCheckboxName });
    sdk.LayerSwitcher.setLayerCheckboxChecked({ name: timeZonesLayerCheckboxName, isChecked: _settings.layers.timeZones.visible });

    sdk.Events.on({ eventName: 'wme-layer-checkbox-toggled', eventHandler: onLayerCheckboxToggled });
    sdk.Events.on({ eventName: 'wme-map-move-end', eventHandler: onMapMoveEnd });
  }

  const LAYER_NAME_MAP = {
    zips: ZIPS_LAYER_NAME,
    counties: COUNTIES_LAYER_NAME,
    states: STATES_LAYER_NAME,
    timeZones: TIME_ZONES_LAYER_NAME,
  };

  const WME_FONT = '"Rubik","Waze Boing","Waze Boing HB light",sans-serif';
  const V = {
    contentDefault: 'var(--content_default)',
    contentP1: 'var(--content_p1)',
    contentP2: 'var(--content_p2)',
    contentP3: 'var(--content_p3)',
    hairline: 'var(--hairline)',
    surfaceDefault: 'var(--surface_default)',
    surfaceVariant: 'var(--surface_variant)',
    separator: 'var(--separator_default)',
    primary: 'var(--primary)',
    primaryVariant: 'var(--primary_variant)',
    onPrimary: 'var(--on_primary)',
    bgDefault: 'var(--background_default)',
  };

  function buildLayerFieldsetHtml(layerKey, displayName, opts = {}) {
    const s = _settings.layers[layerKey];
    const { showMinZoom = false, showDynamicLabels = true } = opts;
    const pfx = `usgb-${layerKey}`;

    let html = `<fieldset style="border:1px solid ${V.hairline};padding:12px;border-radius:8px;margin-bottom:8px;background:${V.bgDefault};">`;
    html += `<legend style="margin-bottom:0;border-bottom-style:none;width:auto;padding:0 4px;">
      <span style="font-family:${WME_FONT};font-size:14px;font-weight:500;color:${V.contentDefault};letter-spacing:0.2px;">${displayName}</span>
    </legend>`;

    if (showDynamicLabels) {
      html += `<div style="padding-top:0;margin-bottom:8px;display:flex;align-items:center;gap:8px;">
        <input type="checkbox" id="${pfx}-dynamicLabels" ${s.dynamicLabels ? 'checked' : ''}
          style="width:16px;height:16px;accent-color:${V.primary};cursor:pointer;" />
        <label for="${pfx}-dynamicLabels" style="font-family:${WME_FONT};font-size:13px;color:${V.contentP1};letter-spacing:0.2px;cursor:pointer;">Dynamic label positions</label>
      </div>`;
    }

    html += `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
      <label style="font-family:${WME_FONT};font-size:13px;color:${V.contentP2};min-width:30px;letter-spacing:0.2px;">Color</label>
      <input type="color" id="${pfx}-color" value="${s.color}"
        style="width:32px;height:28px;padding:1px;border:1px solid ${V.hairline};border-radius:4px;cursor:pointer;background:${V.surfaceDefault};" />
      <label style="font-family:${WME_FONT};font-size:13px;color:${V.contentP2};min-width:50px;letter-spacing:0.2px;">Label Outline</label>
      <input type="color" id="${pfx}-labelOutlineColor" value="${s.labelOutlineColor}"
        style="width:32px;height:28px;padding:1px;border:1px solid ${V.hairline};border-radius:4px;cursor:pointer;background:${V.surfaceDefault};" />
    </div>`;

    html += `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
      <label for="${pfx}-opacity" style="font-family:${WME_FONT};font-size:13px;color:${V.contentP2};min-width:42px;letter-spacing:0.2px;">Opacity</label>
      <input type="range" id="${pfx}-opacity" min="0" max="1" step="0.05" value="${s.opacity}"
        style="flex:1;accent-color:${V.primary};height:4px;" />
      <span id="${pfx}-opacity-val" style="font-family:${WME_FONT};font-size:13px;color:${V.contentP3};min-width:28px;text-align:right;">${s.opacity}</span>
    </div>`;

    if (showMinZoom) {
      html += `<div style="display:flex;align-items:center;gap:8px;">
        <label for="${pfx}-minZoom" style="font-family:${WME_FONT};font-size:13px;color:${V.contentP2};letter-spacing:0.2px;">Min Zoom</label>
        <input type="number" id="${pfx}-minZoom" min="1" max="22" value="${s.minZoom}"
          style="width:56px;height:32px;font-family:${WME_FONT};font-size:13px;color:${V.contentDefault};border:1px solid ${V.hairline};border-radius:4px;padding:0 8px;background:${V.surfaceDefault};" />
      </div>`;
    }

    html += '</fieldset>';
    return html;
  }

  function attachLayerSettingsListeners(section, layerKey) {
    const pfx = `usgb-${layerKey}`;

    const dlCb = section.querySelector(`#${pfx}-dynamicLabels`);
    if (dlCb) {
      dlCb.addEventListener('change', () => {
        _settings.layers[layerKey].dynamicLabels = dlCb.checked;
        saveSettings();
        fetchBoundaries();
      });
    }

    ['color', 'labelOutlineColor'].forEach((prop) => {
      const input = section.querySelector(`#${pfx}-${prop}`);
      if (input) {
        input.addEventListener('change', () => {
          _settings.layers[layerKey][prop] = input.value;
          saveSettings();
          sdk.Map.redrawLayer({ layerName: LAYER_NAME_MAP[layerKey] });
        });
      }
    });

    const opacityInput = section.querySelector(`#${pfx}-opacity`);
    if (opacityInput) {
      opacityInput.addEventListener('input', () => {
        const val = parseFloat(opacityInput.value);
        _settings.layers[layerKey].opacity = val;
        section.querySelector(`#${pfx}-opacity-val`).textContent = val.toFixed(2);
        sdk.Map.setLayerOpacity({ layerName: LAYER_NAME_MAP[layerKey], opacity: val });
        saveSettings();
      });
    }

    const minZoomInput = section.querySelector(`#${pfx}-minZoom`);
    if (minZoomInput) {
      minZoomInput.addEventListener('change', () => {
        _settings.layers[layerKey].minZoom = parseInt(minZoomInput.value, 10);
        saveSettings();
        fetchBoundaries();
      });
    }
  }

  function initTab() {
    const section = document.createElement('div');
    section.style.cssText = `font-family:${WME_FONT};font-size:14px;letter-spacing:0.2px;line-height:20px;color:${V.contentDefault};padding:8px 4px;`;

    let html = '';
    html += buildLayerFieldsetHtml('states', 'States', { showDynamicLabels: false });
    html += buildLayerFieldsetHtml('counties', 'Counties', { showMinZoom: true });
    html += buildLayerFieldsetHtml('zips', 'ZIP Codes', { showMinZoom: true });
    html += buildLayerFieldsetHtml('timeZones', 'Time Zones');

    const btnBase = `font-family:${WME_FONT};font-size:13px;font-weight:500;letter-spacing:0.2px;border-radius:8px;cursor:pointer;transition:background 0.15s,border-color 0.15s;`;
    const btnPrimary = `${btnBase}height:36px;padding:0 16px;background:${V.primary};color:${V.onPrimary};border:none;`;
    const btnSecondary = `${btnBase}height:36px;padding:0 16px;background:${V.bgDefault};color:${V.contentDefault};border:1px solid ${V.hairline};`;

    html += `<fieldset style="border:1px solid ${V.hairline};padding:12px;border-radius:8px;margin-bottom:8px;background:${V.bgDefault};">`;
    html += `<legend style="margin-bottom:0;border-bottom-style:none;width:auto;padding:0 4px;">
      <span style="font-family:${WME_FONT};font-size:14px;font-weight:500;color:${V.contentDefault};letter-spacing:0.2px;">USPS Routes</span>
    </legend>`;
    html += `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
      <label for="usgb-usps-radius" style="font-family:${WME_FONT};font-size:13px;color:${V.contentP2};letter-spacing:0.2px;">Radius (mi)</label>
      <input type="number" id="usgb-usps-radius" min="0.5" max="2" step="0.1" value="${_settings.uspsRoutes.radius}"
        style="width:64px;height:32px;font-family:${WME_FONT};font-size:13px;color:${V.contentDefault};border:1px solid ${V.hairline};border-radius:4px;padding:0 8px;background:${V.surfaceDefault};" />
    </div>`;
    html += `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
      <label for="usgb-usps-opacity" style="font-family:${WME_FONT};font-size:13px;color:${V.contentP2};min-width:42px;letter-spacing:0.2px;">Opacity</label>
      <input type="range" id="usgb-usps-opacity" min="0" max="1" step="0.05" value="${_settings.uspsRoutes.opacity}"
        style="flex:1;accent-color:${V.primary};height:4px;" />
      <span id="usgb-usps-opacity-val" style="font-family:${WME_FONT};font-size:13px;color:${V.contentP3};min-width:28px;text-align:right;">${_settings.uspsRoutes.opacity}</span>
    </div>`;
    html += `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
      <button id="usgb-get-usps-routes" style="${btnPrimary}">Get USPS Routes</button>
      <button id="usgb-clear-usps-routes" style="${btnSecondary}">Clear</button>
    </div>`;
    html += '<div id="usgb-usps-route-results" style="margin-top:4px;"></div>';
    html += '</fieldset>';

    html += `<div style="margin-top:8px;margin-bottom:12px;">
      <button id="usgb-reset-defaults" style="${btnSecondary}width:100%;">Reset All to Defaults</button>
    </div>`;

    html += `<div style="background:${V.surfaceDefault};border-radius:8px;padding:12px;margin-bottom:8px;">
      <span style="font-family:${WME_FONT};font-size:12px;color:${V.contentP3};line-height:18px;letter-spacing:0.2px;white-space:pre-line;">Notes:
- ZIP code boundaries are rough approximations because ZIP codes are not actually areas. Prefer the "Get USPS routes" feature whenever possible.
- Time zone boundaries are rough approximations, and may not display properly above zoom level 5.</span>
    </div>`;

    section.innerHTML = html;

    sdk.Sidebar.registerScriptTab()
      .then(({ tabLabel, tabPane }) => {
        tabLabel.textContent = 'USGB';
        tabLabel.title = 'US Government Boundaries';
        tabPane.appendChild(section);

        ['zips', 'counties', 'states', 'timeZones'].forEach((key) => {
          attachLayerSettingsListeners(section, key);
        });

        const uspsRadiusInput = section.querySelector('#usgb-usps-radius');
        if (uspsRadiusInput) {
          uspsRadiusInput.addEventListener('change', () => {
            _settings.uspsRoutes.radius = parseFloat(uspsRadiusInput.value);
            saveSettings();
          });
        }

        const uspsOpacityInput = section.querySelector('#usgb-usps-opacity');
        if (uspsOpacityInput) {
          uspsOpacityInput.addEventListener('input', () => {
            const val = parseFloat(uspsOpacityInput.value);
            _settings.uspsRoutes.opacity = val;
            section.querySelector('#usgb-usps-opacity-val').textContent = val.toFixed(2);
            sdk.Map.setLayerOpacity({ layerName: USPS_ROUTES_LAYER_NAME, opacity: val });
            saveSettings();
          });
        }

        _$uspsResultsDiv = $(section.querySelector('#usgb-usps-route-results'));
        _$getRoutesButton = $(section.querySelector('#usgb-get-usps-routes'));
        _$getRoutesButton.click(onGetRoutesButtonClick).mouseenter(onGetRoutesButtonMouseEnter).mouseout(onGetRoutesButtonMouseLeave);
        $(section.querySelector('#usgb-clear-usps-routes')).click(onClearRoutesButtonClick);

        const resetBtn = section.querySelector('#usgb-reset-defaults');
        if (resetBtn) {
          resetBtn.addEventListener('click', () => {
            const defaults = getDefaultSettings();
            _settings = defaults;
            saveSettings();

            ['zips', 'counties', 'states', 'timeZones'].forEach((key) => {
              const pfx = `usgb-${key}`;
              const s = _settings.layers[key];

              const dlCb = section.querySelector(`#${pfx}-dynamicLabels`);
              if (dlCb) dlCb.checked = s.dynamicLabels;

              const cc = section.querySelector(`#${pfx}-color`);
              if (cc) cc.value = s.color;
              const loc = section.querySelector(`#${pfx}-labelOutlineColor`);
              if (loc) loc.value = s.labelOutlineColor;

              const op = section.querySelector(`#${pfx}-opacity`);
              if (op) {
                op.value = s.opacity;
                const opVal = section.querySelector(`#${pfx}-opacity-val`);
                if (opVal) opVal.textContent = s.opacity;
              }
              sdk.Map.setLayerOpacity({ layerName: LAYER_NAME_MAP[key], opacity: s.opacity });

              const mz = section.querySelector(`#${pfx}-minZoom`);
              if (mz && s.minZoom !== undefined) mz.value = s.minZoom;
            });

            const ur = section.querySelector('#usgb-usps-radius');
            if (ur) ur.value = _settings.uspsRoutes.radius;
            const uo = section.querySelector('#usgb-usps-opacity');
            if (uo) {
              uo.value = _settings.uspsRoutes.opacity;
              const uoVal = section.querySelector('#usgb-usps-opacity-val');
              if (uoVal) uoVal.textContent = _settings.uspsRoutes.opacity;
            }
            sdk.Map.setLayerOpacity({ layerName: USPS_ROUTES_LAYER_NAME, opacity: _settings.uspsRoutes.opacity });

            fetchBoundaries();
          });
        }
      })
      .catch((error) => {
        logError(`Error creating script tab: ${error}`);
      });
  }

  function init() {
    loadSettings();
    initLayers();
    initTab();
    showScriptInfoAlert();
    fetchBoundaries();
    log('Initialized.');
  }

  init();
})();
