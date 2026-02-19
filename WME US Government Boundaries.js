// ==UserScript==
// @name            WME US Government Boundaries
// @namespace       https://greasyfork.org/users/45389
// @version         2026.02.19.00
// @description     Adds a layer to display US (federal, state, and/or local) boundaries with a modern, enhanced UI.
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

/**
 * @fileoverview WME US Government Boundaries - A Waze Map Editor script for visualizing US boundaries
 *
 * @description
 * This UserScript enhances the Waze Map Editor with interactive boundary visualizations for:
 * - ZIP Codes (5-digit ZCTA)
 * - Counties (including parishes and equivalents)
 * - States
 * - Time Zones (UTC offsets)
 * - USPS Delivery Routes (on-demand)
 *
 * ## Key Features
 * - **Modern UI**: Gradient header, preset chips, collapsible layer cards, color pickers, sliders
 * - **Dynamic Labels**: Smart label positioning based on visible polygon portions (prevents clutter)
 * - **Performance Optimizations**:
 *   - Debounced map movement (250ms delay)
 *   - Cached polygon calculations (prevents ~36K redundant calculations/hour)
 *   - Batch feature additions (98% reduction in map operations)
 *   - Event-based z-index management (replaces polling)
 * - **Keyboard Shortcuts**: User-configurable shortcuts for toggling layers and fetching routes
 * - **Style Presets**: High Contrast, Minimal, Colorblind-friendly, Night Mode
 * - **Persistent Settings**: All preferences saved to localStorage
 * - **Dual UI**: Modern panel + legacy WME layer switcher integration
 *
 * ## Architecture
 *
 * ### Data Flow
 * 1. Map movement triggers debounced fetchBoundaries()
 * 2. Parallel AJAX requests to ArcGIS Feature Services for visible layers
 * 3. processBoundaries() extracts polygons, clips to screen, generates labels
 * 4. Batch addition of features to map layers
 * 5. updateNameDisplay() shows zip/county at map center
 *
 * ### External APIs
 * - **TIGER/Line (Census.gov)**: Boundary geometries for zips, counties, states
 * - **ArcGIS Online**: Time zone boundaries
 * - **USPS EDDM**: Postal delivery route geometries
 * - **WazeX**: City name lookup for ZIP codes
 *
 * ### Dependencies
 * - Turf.js v7: Geospatial operations (intersections, area, point-in-polygon, etc.)
 * - WazeWrap: Convenience utilities for WME scripting
 * - Bootstrap (WME Utils): WME API SDK wrapper with modern architecture
 * - Font Awesome 6.4: UI icons
 * - Google Fonts (JetBrains Mono, Rubik): UI typography
 *
 * ### File Structure
 * - Constants & Settings (lines 28-135)
 * - Utility Functions (lines 137-216): Logging, settings management, polygon caching
 * - Geometry Processing (lines 217-518): Polygon extraction, label generation, boundary processing
 * - API/Data Fetching (lines 520-711): USPS routes, boundary fetching
 * - Event Handlers (lines 713-848): Map events, button clicks, layer toggles
 * - Layer Initialization (lines 849-1353): Map layer setup with style rules
 * - Keyboard Shortcuts (lines 1369-1634): Shortcut registration and management
 * - Modern UI Implementation (lines 1636-2930): CSS injection and DOM building
 * - Main Initialization (lines 3068+): Bootstrap and orchestration
 *
 * ## Maintenance Notes
 *
 * ### Common Gotchas
 * - **Ring Orientation**: ArcGIS uses right-hand rule; first ring is outer, subsequent may be holes or islands
 * - **SDK Shortcut Formats**: SDK returns inconsistent formats (combo on load, raw after changes)
 * - **Context Cancellation**: Always check `context.cancel` before async operations complete
 * - **Z-Index Management**: USPS routes must stay at `roads.zIndex - 2` for visibility
 *
 * ### Performance Considerations
 * - Polygon caching is critical for performance (see ensurePolygonCaches)
 * - Batch feature additions prevent map lag (single addFeatures call per layer)
 * - Debouncing prevents API spam during rapid panning
 * - Label filtering (0.5% screen area threshold) prevents excessive labels
 *
 * ### Testing Checklist
 * - [ ] Zoom levels: Test at 4, 8, 12, 16, 22 (boundary visibility thresholds)
 * - [ ] Boundary overlap: Verify multi-ring polygons (e.g., Michigan, Hawaii)
 * - [ ] Map edges: Check clipping polygon prevents artifacts
 * - [ ] Preset application: Verify all 4 presets update UI immediately
 * - [ ] Shortcut conflicts: Test duplicate key handling
 * - [ ] Settings persistence: Verify localStorage save/load
 *
 * @author MapOMatic
 * @author JS55CT (Modern UI redesign)
 * @license GNU GPLv3
 * @see {@link https://greasyfork.org/scripts/25631|GreasyFork Script Page}
 * @see {@link https://www.waze.com/discuss/t/115019|Waze Forum Discussion}
 */

/* global turf */
/* global WazeWrap */
/* global bootstrap */

(async function main() {
  'use strict';

  const UPDATE_MESSAGE = 'Modern UI redesign with enhanced controls, keyboard shortcuts, and improved user experience!';
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

  /**
   * Calculates the maximum allowable offset (generalization) for boundary features based on zoom level.
   * Higher zoom levels (more zoomed in) require smaller offsets for more detailed rendering.
   * This value is used by the ArcGIS API to simplify polygon geometries for better performance.
   *
   * @param {number} zoomLevel - Current map zoom level (typically 4-22)
   * @returns {number} Maximum allowable offset in degrees (latitude/longitude units)
   * @see {@link https://developers.arcgis.com/rest/services-reference/query-feature-service-layer-.htm#ESRI_SECTION1_4214B5AB48434C0D81F8208AD839E5FD|ArcGIS maxAllowableOffset}
   */
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

  /**
   * Logs a general informational message to the console with the USGB prefix.
   *
   * @param {string|Error|Object} message - Message to log (strings, objects, or errors)
   */
  function log(message) {
    console.log('USGB:', message);
  }

  /**
   * Logs a debug message to the console with the USGB prefix.
   * Used for development and troubleshooting purposes.
   *
   * @param {string|Error|Object} message - Debug message to log
   */
  function logDebug(message) {
    console.log('USGB:', message);
  }

  /**
   * Logs an error message to the console with the USGB prefix.
   * Uses console.error for better visibility in developer tools.
   *
   * @param {string|Error|Object} message - Error message or Error object to log
   */
  function logError(message) {
    console.error('USGB:', message);
  }

  /**
   * Returns the default settings object for the script.
   * Used when no saved settings exist in localStorage or to fill in missing properties.
   *
   * @returns {Object} Default settings object containing:
   *   - lastVersion: Script version for update tracking
   *   - layers: Configuration for each boundary layer (zips, counties, states, timeZones)
   *     - visible: Layer visibility state
   *     - dynamicLabels: Whether to use smart label positioning
   *     - color: Stroke and label color
   *     - labelOutlineColor: Text outline color for contrast
   *     - opacity: Layer opacity (0-1)
   *     - minZoom: Minimum zoom level to fetch/display (for zips and counties)
   *   - uspsRoutes: USPS routes search configuration
   *   - shortcuts: Keyboard shortcut definitions (raw and combo format)
   */
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
      shortcuts: {
        'usgb-toggle-zips': { raw: null, combo: null },
        'usgb-toggle-counties': { raw: null, combo: null },
        'usgb-toggle-states': { raw: null, combo: null },
        'usgb-toggle-timezones': { raw: null, combo: null },
        'usgb-fetch-usps-routes': { raw: null, combo: null },
      },
    };
  }

  /**
   * Recursively ensures that all properties from the default settings exist in the loaded settings.
   * This handles cases where new settings properties are added in script updates.
   * Modifies the obj parameter in-place by adding missing properties from defaultObj.
   *
   * @param {Object} obj - Settings object to validate (will be modified in-place)
   * @param {Object} defaultObj - Default settings object to use as template
   */
  function checkSettings(obj, defaultObj) {
    Object.keys(defaultObj).forEach((key) => {
      if (!obj.hasOwnProperty(key)) {
        obj[key] = defaultObj[key];
      } else if (defaultObj[key] && defaultObj[key].constructor === {}.constructor) {
        checkSettings(obj[key], defaultObj[key]);
      }
    });
  }

  /**
   * Loads user settings from localStorage and merges them with default settings.
   * If no saved settings exist, uses defaults. Missing properties from defaults
   * are added to handle script updates.
   * Sets the global _settings variable.
   */
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

  /**
   * Persists current settings to localStorage as a JSON string.
   * Called whenever settings are modified (layer changes, shortcuts, etc.).
   */
  function saveSettings() {
    if (localStorage) {
      localStorage.setItem(SETTINGS_STORE_NAME, JSON.stringify(_settings));
      //log('Settings saved');
    }
  }

  /**
   * Ensures that polygon caches are current for the active map extent.
   * Creates/updates three cached values to avoid redundant calculations:
   * - Screen polygon: Represents the visible map area
   * - Screen area: Area in square meters of visible map
   * - Clip polygon: Expanded area used to clip boundary features (prevents edge artifacts)
   *
   * Only recalculates if the map extent has changed. This optimization prevents
   * recalculating these expensive turf.js operations on every feature processed.
   *
   * @performance Critical optimization - prevents ~36,000 redundant calculations per hour
   */
  function ensurePolygonCaches() {
    const ext = sdk.Map.getMapExtent();

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
      return;
    }

    _cachedExtent = ext;

    _cachedScreenPolygon = turf.polygon([
      [
        [ext[0], ext[3]],
        [ext[2], ext[3]],
        [ext[2], ext[1]],
        [ext[0], ext[1]],
        [ext[0], ext[3]],
      ],
    ]);

    _cachedScreenArea = turf.area(_cachedScreenPolygon);

    const width = ext[2] - ext[0];
    const height = ext[3] - ext[1];
    const expandBy = 2;
    const clipBox = [ext[0] - width * expandBy, ext[1] - height * expandBy, ext[2] + width * expandBy, ext[3] + height * expandBy];
    _cachedClipPolygon = turf.bboxPolygon(clipBox);
  }

  /**
   * Returns a cached Turf.js polygon representing the current visible map area.
   * Updates cache if map extent has changed.
   *
   * @returns {Object} Turf.js polygon feature
   */
  function getScreenPolygon() {
    ensurePolygonCaches();
    return _cachedScreenPolygon;
  }

  /**
   * Returns the cached area (in square meters) of the current visible map.
   * Used to determine if boundary labels should be shown based on size threshold.
   * Updates cache if map extent has changed.
   *
   * @returns {number} Area in square meters
   */
  function getScreenArea() {
    ensurePolygonCaches();
    return _cachedScreenArea;
  }

  /**
   * Returns a cached Turf.js polygon expanded beyond the visible map area.
   * Used to clip boundary features to prevent rendering artifacts at screen edges.
   * The clip polygon extends 2x the screen dimensions in all directions.
   * Updates cache if map extent has changed.
   *
   * @returns {Object} Turf.js polygon feature (expanded bounding box)
   */
  function getClipPolygon() {
    ensurePolygonCaches();
    return _cachedClipPolygon;
  }

  /**
   * Constructs an ArcGIS REST API query URL for fetching boundary features within a map extent.
   * Builds a complete URL with all necessary parameters for the Feature Service query endpoint.
   *
   * @param {string} baseUrl - Base URL of the ArcGIS Feature Service layer (e.g., ZIPS_LAYER_URL)
   * @param {number[]} extent - Map extent as [minLon, minLat, maxLon, maxLat] (WGS84)
   * @param {number} zoom - Current map zoom level (used to determine geometry simplification)
   * @param {string[]} outFields - Array of field names to return (e.g., ['ZCTA5', 'NAME'])
   * @param {string} [fParam='json'] - Response format ('json' or other ArcGIS-supported formats)
   * @returns {string} Complete ArcGIS query URL with all parameters
   * @see {@link https://developers.arcgis.com/rest/services-reference/query-feature-service-layer-.htm|ArcGIS Query API}
   */
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

  /**
   * Appends city and state information to a displayed zip code in the UI.
   * Called after fetching city data from the WazeX API. Updates the ZIP_CITIES cache
   * and appends the city/state to the #zip-text element if the context is still valid.
   *
   * @param {string} zip - Five-digit zip code
   * @param {Object} cityState - Response object containing city and state
   * @param {string} cityState.city - City name
   * @param {string} cityState.state - Two-letter state abbreviation
   * @param {boolean} [cityState.error] - Indicates if the lookup failed
   * @param {Object} context - Processing context with cancel flag
   * @param {boolean} context.cancel - If true, operation was cancelled (map moved)
   */
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

  /**
   * Updates the boundary name display in the UI based on the map center location.
   * Performs point-in-polygon tests to determine which boundaries contain the map center,
   * then displays zip code (with city lookup) and/or county name in the UI.
   * Respects the context.cancel flag to avoid updating after the map has moved.
   *
   * @param {Object} context - Processing context to check cancellation
   * @param {boolean} context.cancel - If true, display update is skipped
   */
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

  /**
   * Processes a boundary feature with complex geometry (potentially with holes/islands).
   * Handles ArcGIS ring-based geometries where the first ring is the outer boundary and
   * subsequent rings may be holes (contained) or separate polygons (non-contained islands).
   *
   * Process:
   * 1. Starts with the first ring as the main outer polygon
   * 2. For each additional ring:
   *    - If contained within main polygon → it's a hole, subtract it using turf.difference
   *    - If NOT contained → it's a separate island, add to externalPolygons array
   * 3. Clips all resulting polygons to the expanded screen area to prevent edge artifacts
   * 4. Handles the clipping result which may return Polygon or MultiPolygon geometries
   *
   * @param {Object} boundary - ArcGIS feature with ring-based geometry
   * @param {Object} boundary.geometry - Geometry object
   * @param {number[][][]} boundary.geometry.rings - Array of coordinate rings
   * @param {Object} attributes - Properties to attach to resulting Turf.js features
   * @returns {Object[]} Array of Turf.js polygon features, clipped and ready for rendering
   */
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
      if (!polygon) return;

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

  /**
   * Generates optimally-positioned label points for a boundary feature.
   * Implements "dynamic labels" by calculating the visible portions of a boundary
   * and placing labels at the center of mass of each significant visible section.
   *
   * Process:
   * 1. Intersects the boundary feature with the visible screen area
   * 2. Filters out polygons smaller than 0.5% of screen area (too small for labels)
   * 3. For each significant visible section:
   *    - Calculates center of mass
   *    - If center is outside polygon (concave shapes), uses pointOnFeature instead
   * 4. Returns array of label point features
   *
   * This prevents label clutter when boundaries are partially visible or span multiple
   * screen areas, ensuring labels appear in the most visually prominent locations.
   *
   * @param {Object} feature - Turf.js polygon feature representing a boundary
   * @param {Object} feature.properties - Must contain name property for the label
   * @returns {Object[]} Array of Turf.js point features for label rendering
   */
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

  /**
   * Processes boundary features from ArcGIS API response and renders them on the map.
   * This is the core processing function that handles all boundary types (zips, counties, states, timeZones).
   *
   * Process:
   * 1. Determines layer settings and name based on boundary type
   * 2. Formats boundary names (e.g., prepends zero-width joiner to zips, formats UTC timezones)
   * 3. Extracts and clips polygons from complex ring-based geometries
   * 4. Generates dynamic label points or suppresses labels for small features
   * 5. Batch-adds all polygons and labels to the map layer
   * 6. Caches zip/county features for the name display feature
   * 7. Triggers updateNameDisplay when all boundary types finish processing
   *
   * @param {Object[]} boundaries - Array of ArcGIS feature objects with ring-based geometries
   * @param {Object} context - Processing context for this fetch operation
   * @param {boolean} context.cancel - If true, processing is aborted (map moved)
   * @param {number} context.callCount - Tracks how many boundary types are still processing
   * @param {string} type - Boundary type: 'zip', 'county', 'state', or 'timeZone'
   * @param {string} nameField - ArcGIS attribute field name containing the boundary name
   */
  function processBoundaries(boundaries, context, type, nameField) {
    let layerName;
    let layerSettings;

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

            allPolygons.push(...features);

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

        if (allPolygons.length && !context.cancel) {
          try {
            sdk.Map.addFeaturesToLayer({ layerName, features: allPolygons });
          } catch (ex) {
            logError('FAIL adding polygons: ', ex);
          }
        }

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
  }

  /**
   * Generates the USPS EDDM (Every Door Direct Mail) API URL for fetching delivery routes.
   * Replaces template placeholders with actual coordinates and search radius.
   *
   * @param {number} lon - Longitude of search center (WGS84)
   * @param {number} lat - Latitude of search center (WGS84)
   * @param {number} radius - Search radius in miles
   * @returns {string} Complete USPS EDDM API URL
   * @see {@link https://gis.usps.com/arcgis/rest/services/EDDM/|USPS EDDM Service}
   */
  function getUspsRoutesUrl(lon, lat, radius) {
    return USPS_ROUTES_URL_TEMPLATE.replace('{lon}', lon).replace('{lat}', lat).replace('{radius}', radius);
  }

  /**
   * Creates a Turf.js circle feature representing the USPS routes search area.
   * Displayed on map when hovering over the "Get Routes" button to preview search radius.
   *
   * @returns {Object} Turf.js polygon feature (72-sided circle approximation)
   */
  function getUspsCircleFeature() {
    let center = sdk.Map.getMapCenter();
    center = [center.lon, center.lat];
    const radius = _settings.uspsRoutes.radius;
    const options = { steps: 72, units: 'miles', properties: { type: 'circle' } };
    return turf.circle(center, radius, options);
  }

  /**
   * Processes the USPS EDDM API response and renders routes on the map.
   * Groups individual route segments by City/Zip, assigns colors, creates line features,
   * and updates the UI with a legend showing route names and colors.
   *
   * Process:
   * 1. Parses JSON response and groups routes by "City, State ZipCode"
   * 2. Assigns one of 6 predefined colors to each zip's routes
   * 3. Converts multiLineString geometries to individual lineString features
   * 4. Adds visual legend to UI showing route names with color swatches
   * 5. Renders all routes on map with z-index ordering for visual clarity
   *
   * @param {Object} res - GM_xmlhttpRequest response object
   * @param {string} res.responseText - JSON string from USPS API
   */
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

      _$uspsResultsDiv.append(
        $('<div>', { class: 'usgb-route-item' })
          .append($('<div>', { class: 'usgb-route-color' }).css({ background: color }))
          .append($('<div>', { class: 'usgb-route-name' }).text(zipName)),
      );
      routeIdx++;
    });
    _$getRoutesButton.removeAttr('disabled').css({ opacity: '' });
    sdk.Map.addFeaturesToLayer({ layerName: USPS_ROUTES_LAYER_NAME, features });
  }

  /**
   * Initiates a USPS routes search centered at the current map position.
   * Shows loading state, clears previous results, fetches routes from USPS API,
   * and processes the response to display routes on the map.
   *
   * @fires GM_xmlhttpRequest - Cross-domain AJAX to USPS EDDM service
   */
  function fetchUspsRoutesFeatures() {
    const centerLonLat = sdk.Map.getMapCenter();
    const url = getUspsRoutesUrl(centerLonLat.lon, centerLonLat.lat, _settings.uspsRoutes.radius);

    _$getRoutesButton.attr('disabled', 'true').css({ opacity: '0.5' });
    const originalButtonHTML = _$getRoutesButton.html();
    _$getRoutesButton.html('<i class="fas fa-spinner fa-spin"></i> Loading...');

    _$uspsResultsDiv.empty().append(`
      <div class="usgb-loading-wrapper">
        <div class="usgb-loading-spinner"></div>
        <div class="usgb-loading-text">Fetching USPS routes...</div>
      </div>
    `);

    sdk.Map.removeAllFeaturesFromLayer({ layerName: USPS_ROUTES_LAYER_NAME });
    _uspsRoutesActive = true;
    ensureUspsRoutesZIndex();
    GM_xmlhttpRequest({
      url,
      onload: (res) => {
        _$getRoutesButton.html(originalButtonHTML);
        processUspsRoutesResponse(res);
      },
      onerror: () => {
        _$getRoutesButton.removeAttr('disabled').css({ opacity: '' }).html(originalButtonHTML);
        _$uspsResultsDiv.empty();
      },
      anonymous: true,
    });
  }

  /**
   * Fetches boundary features for all enabled layers from their respective ArcGIS services.
   * This is the main orchestration function called whenever the map view changes.
   *
   * Process:
   * 1. Cancels any in-flight boundary processing by setting cancel flags
   * 2. Aborts all pending AJAX requests to prevent stale data
   * 3. Creates a shared processing context to coordinate multiple async operations
   * 4. Initiates parallel AJAX requests for each enabled boundary type:
   *    - Zips: Only if zoom >= minZoom (default 12)
   *    - Counties: Only if zoom >= minZoom (default 8)
   *    - Time Zones: Always fetched if visible
   *    - States: Always fetched if visible
   * 5. Each successful response calls processBoundaries()
   * 6. When all requests complete (context.callCount reaches 0), updates the name display
   *
   * @performance Debounced by debouncedFetchBoundaries() to prevent excessive API calls during map panning
   */
  function fetchBoundaries() {
    if (PROCESS_CONTEXTS.length > 0) {
      PROCESS_CONTEXTS.forEach((context) => {
        context.cancel = true;
      });
    }

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

  /**
   * Handles layer checkbox toggle events from the WME layer switcher.
   * Updates settings, layer visibility, syncs the modern UI toggle state, and re-fetches boundaries.
   *
   * @param {Object} args - Event arguments from wme-layer-checkbox-toggled
   * @param {string} args.name - Checkbox name (e.g., "USGB - Zip codes")
   * @param {boolean} args.checked - New checked state
   * @fires fetchBoundaries - Triggers boundary re-fetch with new visibility settings
   */
  function onLayerCheckboxToggled(args) {
    let layerName;
    let settingsObj;
    let layerKey;
    switch (args.name) {
      case zipsLayerCheckboxName:
        layerName = ZIPS_LAYER_NAME;
        settingsObj = _settings.layers.zips;
        layerKey = 'zips';
        break;
      case countiesLayerCheckboxName:
        layerName = COUNTIES_LAYER_NAME;
        settingsObj = _settings.layers.counties;
        layerKey = 'counties';
        break;
      case statesLayerCheckboxName:
        layerName = STATES_LAYER_NAME;
        settingsObj = _settings.layers.states;
        layerKey = 'states';
        break;
      case timeZonesLayerCheckboxName:
        layerName = TIME_ZONES_LAYER_NAME;
        settingsObj = _settings.layers.timeZones;
        layerKey = 'timeZones';
        break;
      default:
        throw new Error('Unexpected layer switcher checkbox name.');
    }
    const visibility = args.checked;
    settingsObj.visible = visibility;
    saveSettings();
    sdk.Map.setLayerVisibility({ layerName, visibility });

    // Sync with modern UI visibility toggle
    const layerCard = document.querySelector(`.usgb-layer-card[data-layer="${layerKey}"]`);
    if (layerCard) {
      const toggle = layerCard.querySelector('.usgb-visibility-toggle');
      if (toggle) {
        if (visibility) {
          toggle.classList.add('active');
        } else {
          toggle.classList.remove('active');
        }
      }
    }

    fetchBoundaries();
  }

  /**
   * Click handler for the "Get Routes" button.
   * Initiates USPS routes search at the current map center.
   */
  function onGetRoutesButtonClick() {
    fetchUspsRoutesFeatures();
  }

  /**
   * Mouse enter handler for the "Get Routes" button.
   * Displays a preview circle on the map showing the search radius.
   */
  function onGetRoutesButtonMouseEnter() {
    const feature = getUspsCircleFeature();
    feature.id = 'uspsCircle';
    sdk.Map.addFeatureToLayer({ layerName: USPS_ROUTES_LAYER_NAME, feature });
  }

  /**
   * Mouse leave handler for the "Get Routes" button.
   * Removes the preview circle from the map.
   */
  function onGetRoutesButtonMouseLeave() {
    sdk.Map.removeFeatureFromLayer({ layerName: USPS_ROUTES_LAYER_NAME, featureId: 'uspsCircle' });
  }

  /**
   * Click handler for the "Clear Routes" button.
   * Removes all USPS route features from the map and clears the routes legend.
   */
  function onClearRoutesButtonClick() {
    sdk.Map.removeAllFeaturesFromLayer({ layerName: USPS_ROUTES_LAYER_NAME });
    _$uspsResultsDiv.empty();
    _uspsRoutesActive = false;
  }

  /**
   * Debounces the fetchBoundaries call to prevent excessive API requests during map panning.
   * Cancels any pending fetch and schedules a new one after the specified delay.
   *
   * @param {number} [delay=250] - Delay in milliseconds before fetching boundaries
   * @performance Prevents API call spam - only fetches after user stops panning for 250ms
   */
  function debouncedFetchBoundaries(delay = 250) {
    clearTimeout(_fetchBoundariesTimeout);
    _fetchBoundariesTimeout = setTimeout(() => {
      fetchBoundaries();
    }, delay);
  }

  /**
   * Ensures USPS routes layer maintains correct z-index relative to the roads layer.
   * Called on layer add/change/remove events to keep routes visible above roads but below other layers.
   * Positions USPS routes at (roads z-index - 2) for optimal visibility.
   *
   * @performance Event-based z-index management (replaces previous setInterval polling)
   */
  const ensureUspsRoutesZIndex = () => {
    if (!_uspsRoutesActive) return;

    const roadsZIndex = sdk.Map.getLayerZIndex({ layerName: 'roads' });
    const targetZIndex = roadsZIndex - 2;
    const currentZIndex = sdk.Map.getLayerZIndex({ layerName: USPS_ROUTES_LAYER_NAME });
    if (currentZIndex !== targetZIndex) {
      sdk.Map.setLayerZIndex({ layerName: USPS_ROUTES_LAYER_NAME, zIndex: targetZIndex });
    }
  };

  /**
   * Event handler for map movement end events.
   * Triggers a debounced boundary fetch to update displayed boundaries for the new map view.
   *
   * @listens wme-map-move-end
   */
  function onMapMoveEnd() {
    try {
      debouncedFetchBoundaries();
    } catch (e) {
      logError(e);
    }
  }

  /**
   * Displays a WazeWrap update notification to inform users of new script features.
   * Shows script name, version, update message, and forum discussion link.
   */
  function showScriptInfoAlert() {
    WazeWrap.Interface.ShowScriptUpdate(GM_info.script.name, GM_info.script.version, UPDATE_MESSAGE, '', 'https://www.waze.com/discuss/t/115019');
  }

  /**
   * Initializes the Counties boundary layer with styling rules and dynamic label rendering.
   * Creates a map layer that displays county boundaries with labels that adapt to zoom level.
   * At zoom <= 9, shortens labels by removing " County" or " Parish" suffix.
   *
   * @see sdk.Map.addLayer
   */
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

  /**
   * Initializes the States boundary layer with styling rules and dynamic label positioning.
   * Creates separate style predicates for label points and boundary polygons.
   * Labels use y-offset that increases with zoom level and are hidden at very low/high zooms.
   *
   * @see sdk.Map.addLayer
   */
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

  /**
   * Initializes the ZIP Codes boundary layer with styling rules and labels.
   * Labels are positioned with a fixed y-offset (-20px) above the boundary center.
   *
   * @see sdk.Map.addLayer
   */
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

  /**
   * Initializes the Time Zones boundary layer with bold styling for high visibility.
   * Uses thicker stroke (6px) and larger font (18px) compared to other boundary layers.
   * Labels are formatted as "UTC+/-n" in processBoundaries before rendering.
   *
   * @see sdk.Map.addLayer
   */
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

  /**
   * Orchestrates initialization of all map layers, UI controls, and event listeners.
   * This is the primary setup function called during script initialization.
   *
   * Process:
   * 1. Initializes all boundary layers (zips, counties, states, time zones)
   * 2. Creates USPS routes layer with dynamic styling
   * 3. Sets initial opacity and visibility from saved settings
   * 4. Registers z-index management event listeners for USPS routes
   * 5. Adds layer checkboxes to WME layer switcher
   * 6. Sets up map move and layer toggle event handlers
   *
   * @see initZipsLayer, initCountiesLayer, initStatesLayer, initTimeZonesLayer
   */
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

  const LAYER_CHECKBOX_NAME_MAP = {
    zips: zipsLayerCheckboxName,
    counties: countiesLayerCheckboxName,
    states: statesLayerCheckboxName,
    timeZones: timeZonesLayerCheckboxName,
  };

  // ============================================
  // SHORTCUT KEY UTILITIES
  // ============================================

  /**
   * Keycode mapping for A-Z, 0-9, and special keys.
   */
  const KEYCODE_MAP = Object.fromEntries([
    ...Array.from({ length: 26 }, (_, i) => [65 + i, String.fromCharCode(65 + i)]),
    ...Array.from({ length: 10 }, (_, i) => [48 + i, String(i)]),
    // Special keys
    [32, 'Space'],
    [13, 'Enter'],
    [9, 'Tab'],
    [27, 'Esc'],
    [8, 'Backspace'],
    [46, 'Delete'],
    [36, 'Home'],
    [35, 'End'],
    [33, 'PageUp'],
    [34, 'PageDown'],
    [45, 'Insert'],
    // Arrow keys
    [37, '←'],
    [38, '↑'],
    [39, '→'],
    [40, '↓'],
    // Function keys
    [112, 'F1'],
    [113, 'F2'],
    [114, 'F3'],
    [115, 'F4'],
    [116, 'F5'],
    [117, 'F6'],
    [118, 'F7'],
    [119, 'F8'],
    [120, 'F9'],
    [121, 'F10'],
    [122, 'F11'],
    [123, 'F12'],
    // Common punctuation
    [188, ','],
    [190, '.'],
    [191, '/'],
    [186, ';'],
    [222, "'"],
    [219, '['],
    [221, ']'],
    [220, '\\'],
    [189, '-'],
    [187, '='],
    [192, '`'],
  ]);

  /**
   * Modifier lookup values for conversion.
   */
  const MOD_LOOKUP = { C: 1, S: 2, A: 4 };

  /**
   * Modifier flag values for combo-to-display.
   */
  const MOD_FLAGS = [
    { flag: 1, char: 'C' },
    { flag: 2, char: 'S' },
    { flag: 4, char: 'A' },
  ];

  /**
   * Converts a shortcut combo string to raw keycode string for the SDK.
   *
   * The WME SDK is inconsistent in what format it returns for shortcut keys:
   * - On initial load: returns combo format ("0", "A+X", "CS+K")
   * - After user changes: returns raw format ("0,48", "4,65", "3,75")
   * - On page reload: back to combo format again
   *
   * To ensure consistency in our storage, we always convert TO raw format.
   *
   * @param {string} comboStr - Shortcut string from SDK (format varies!)
   * @returns {string} Always returns raw format "modifier,keycode"
   */
  function comboToRawKeycodes(comboStr) {
    if (!comboStr || typeof comboStr !== 'string') return comboStr;

    // If already in raw form (modifier,keycode), return unchanged
    if (/^\d+,\d+$/.test(comboStr)) return comboStr;

    // Handle single digit/letter (no modifiers) - SDK returns just "0" but we need "0,48"
    if (/^[A-Z0-9]$/.test(comboStr)) {
      return `0,${comboStr.charCodeAt(0)}`;
    }

    // Handle combo format like "A+X", "CS+K", etc.
    const match = comboStr.match(/^([ACS]+)\+([A-Z0-9])$/);
    if (!match) return comboStr;

    const [, modStr, keyStr] = match;
    const modValue = modStr.split('').reduce((acc, m) => acc | (MOD_LOOKUP[m] || 0), 0);
    return `${modValue},${keyStr.charCodeAt(0)}`;
  }

  /**
   * Converts raw shortcut keycode to display combo for UI/logging.
   *
   * While we store everything in raw format for consistency, we need human-readable
   * combo format for registering shortcuts with SDK.
   *
   * @param {string} keycodeStr - Raw keycode string "modifier,keycode" or combo format
   * @returns {string|null} Human-readable combo format or null if no shortcut
   */
  function shortcutKeycodesToCombo(keycodeStr) {
    if (!keycodeStr || keycodeStr === 'None') return null;

    // If already in combo form, return unchanged
    if (/^([ACS]+\+)?[A-Z0-9]$/.test(keycodeStr)) return keycodeStr;

    // Handle raw format "modifier,keycode" - convert to readable format
    const parts = keycodeStr.split(',');
    if (parts.length !== 2) return keycodeStr;

    const intMod = parseInt(parts[0], 10);
    const keyNum = parseInt(parts[1], 10);
    if (isNaN(intMod) || isNaN(keyNum)) return keycodeStr;

    const modLetters = MOD_FLAGS.filter(({ flag }) => intMod & flag)
      .map(({ char }) => char)
      .join('');

    const keyChar = KEYCODE_MAP[keyNum] || String(keyNum);

    // Return just the key if no modifiers, otherwise "MOD+KEY"
    return modLetters ? `${modLetters}+${keyChar}` : keyChar;
  }

  /**
   * Saves current shortcut assignments to localStorage.
   * Called on beforeunload to persist user's shortcut choices.
   */
  function saveShortcutSettings() {
    try {
      const allShortcuts = sdk.Shortcuts.getAllShortcuts();
      allShortcuts.forEach((shortcut) => {
        if (_settings.shortcuts[shortcut.shortcutId]) {
          const sdkValue = shortcut.shortcutKeys;
          const raw = comboToRawKeycodes(sdkValue);
          const combo = shortcutKeycodesToCombo(raw);
          _settings.shortcuts[shortcut.shortcutId] = { raw, combo };
        }
      });

      saveSettings();
    } catch (e) {
      logError(`Failed to save shortcut settings: ${e.message}`);
    }
  }

  // ============================================
  // MODERN UI IMPLEMENTATION
  // ============================================

  /**
   * Updates a slider's visual appearance to match its current value.
   * Creates a gradient background showing filled vs unfilled portions and updates
   * the adjacent value display with the percentage.
   *
   * @param {HTMLInputElement} slider - Range input element (0.0-1.0)
   */
  function updateSliderBackground(slider) {
    const value = parseFloat(slider.value);
    const percent = value * 100;
    const primaryColor = '#4a90e2';
    const separatorColor = '#e1e4e8';
    slider.style.background = `linear-gradient(to right, ${primaryColor} 0%, ${primaryColor} ${percent}%, ${separatorColor} ${percent}%, ${separatorColor} 100%)`;
    const valueDisplay = slider.closest('.usgb-slider-group') ? slider.closest('.usgb-slider-group').querySelector('.usgb-slider-value') : null;
    if (valueDisplay) {
      valueDisplay.textContent = `${Math.round(percent)}%`;
    }
  }

  /**
   * Initializes the modern UI by injecting styles and external resources (Font Awesome, Google Fonts).
   * This is a large function that defines all the CSS for the modern UI panel.
   * Creates a comprehensive style sheet with gradients, animations, and modern design patterns.
   *
   * @see buildMainUI - Called after this to build the actual DOM structure
   */
  function initModernUI() {
    // Inject Font Awesome if not already present
    if (!document.querySelector('link[href*="font-awesome"]')) {
      const faLink = document.createElement('link');
      faLink.rel = 'stylesheet';
      faLink.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css';
      document.head.appendChild(faLink);
    }

    // Inject Google Fonts
    const fontLink = document.createElement('link');
    fontLink.rel = 'stylesheet';
    fontLink.href = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap';
    document.head.appendChild(fontLink);

    // Inject Modern UI Styles
    const styleEl = document.createElement('style');
    styleEl.textContent = `
      /* Modern UI Styles for USGB */
      .wme-usgb-panel .usgb-container {
        font-family: 'Rubik', -apple-system, BlinkMacSystemFont, sans-serif;
        color: var(--content_default);
        line-height: 1.6;
        padding-right: 10px;
        padding-left: 3px;
        box-sizing: border-box;
      }

      .wme-usgb-panel .usgb-header {
        background: linear-gradient(135deg, var(--primary) 0%, #5b9ee8 100%);
        padding: 10px;
        border-radius: 12px 12px 0 0;
        margin: -8px -8px 16px -8px;
        position: relative;
        overflow: hidden;
      }

      .wme-usgb-panel .usgb-header::before {
        content: '';
        position: absolute;
        top: -50%;
        right: -20%;
        width: 200px;
        height: 200px;
        background: radial-gradient(circle, rgba(255,255,255,0.15) 0%, transparent 70%);
        pointer-events: none;
      }

      .wme-usgb-panel .usgb-header-content {
        position: relative;
        z-index: 1;
      }

      .wme-usgb-panel .usgb-header-title {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 4px;
      }

      .wme-usgb-panel .usgb-header-icon {
        width: 32px;
        height: 32px;
        background: rgba(255, 255, 255, 0.2);
        backdrop-filter: blur(10px);
        border-radius: 8px;
        display: flex;
        align-items: center;
        justify-content: center;
        color: white;
        font-size: 16px;
      }

      .wme-usgb-panel .usgb-header h1 {
        color: white;
        font-size: 18px;
        font-weight: 600;
        letter-spacing: -0.3px;
        margin: 0;
      }

      .wme-usgb-panel .usgb-header-subtitle {
        color: rgba(255, 255, 255, 0.9);
        font-size: 12px;
        margin-left: 42px;
      }

      .wme-usgb-panel .usgb-quick-presets {
        background: var(--surface_variant);
        padding: 12px;
        border-radius: 8px;
        margin-bottom: 12px;
      }

      .wme-usgb-panel .usgb-presets-label {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.8px;
        color: var(--content_p2);
        margin-bottom: 8px;
        display: block;
      }

      .wme-usgb-panel .usgb-preset-chips {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }

      .wme-usgb-panel .usgb-preset-chip {
        padding: 6px 12px;
        background: var(--background_default);
        border: 1px solid var(--hairline);
        border-radius: 16px;
        font-size: 11px;
        font-weight: 500;
        color: var(--content_p1);
        cursor: pointer;
        transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);
        white-space: nowrap;
      }

      .wme-usgb-panel .usgb-preset-chip:hover {
        background: var(--primary);
        color: white;
        border-color: var(--primary);
        transform: scale(1.05);
      }

      .wme-usgb-panel .usgb-layer-card {
        background: var(--surface_default);
        border-radius: 10px;
        margin-bottom: 10px;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
        overflow: hidden;
        transition: all 250ms cubic-bezier(0.4, 0, 0.2, 1);
        border: 1px solid transparent;
      }

      .wme-usgb-panel .usgb-layer-card:hover {
        box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05);
        border-color: var(--separator);
      }

      .wme-usgb-panel .usgb-layer-card.expanded {
        box-shadow: 0 10px 15px rgba(0, 0, 0, 0.08);
      }

      .wme-usgb-panel .usgb-layer-header {
        padding: 12px 14px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        cursor: pointer;
        user-select: none;
        position: relative;
        transition: background 150ms;
      }

      .wme-usgb-panel .usgb-layer-header:hover {
        background: var(--surface_variant);
      }

      .wme-usgb-panel .usgb-layer-header::before {
        content: '';
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        width: 4px;
        background: var(--accent-color);
        transition: width 150ms;
      }

      .wme-usgb-panel .usgb-layer-title-group {
        display: flex;
        align-items: center;
        gap: 10px;
        flex: 1;
      }

      .wme-usgb-panel .usgb-layer-icon {
        width: 32px;
        height: 32px;
        border-radius: 7px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
        background: linear-gradient(135deg, var(--accent-color) 0%, var(--accent-color-light) 100%);
        color: white;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
      }

      .wme-usgb-panel .usgb-layer-title {
        font-size: 14px;
        font-weight: 600;
        color: var(--content_default);
        letter-spacing: -0.2px;
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .wme-usgb-panel .usgb-layer-controls-inline {
        display: flex;
        align-items: center;
        gap: 10px;
      }

      .wme-usgb-panel .usgb-visibility-toggle {
        position: relative;
        width: 40px;
        height: 22px;
        background: var(--separator);
        border-radius: 11px;
        cursor: pointer;
        transition: background 250ms;
      }

      .wme-usgb-panel .usgb-visibility-toggle.active {
        background: var(--primary);
      }

      .wme-usgb-panel .usgb-visibility-toggle::after {
        content: '';
        position: absolute;
        top: 2px;
        left: 2px;
        width: 18px;
        height: 18px;
        background: white;
        border-radius: 9px;
        transition: transform 250ms;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
      }

      .wme-usgb-panel .usgb-visibility-toggle.active::after {
        transform: translateX(18px);
      }

      .wme-usgb-panel .usgb-expand-icon {
        color: var(--content_p2);
        font-size: 16px;
        transition: transform 250ms;
      }

      .wme-usgb-panel .usgb-layer-card.expanded .usgb-expand-icon {
        transform: rotate(180deg);
      }

      .wme-usgb-panel .usgb-layer-content {
        max-height: 0;
        overflow: hidden;
        transition: max-height 350ms cubic-bezier(0.4, 0, 0.2, 1);
      }

      .wme-usgb-panel .usgb-layer-card.expanded .usgb-layer-content {
        max-height: 600px;
      }

      .wme-usgb-panel .usgb-layer-content-inner {
        padding: 0 14px 14px 14px;
      }

      .wme-usgb-panel .usgb-settings-grid {
        display: grid;
        gap: 12px;
      }

      .wme-usgb-panel .usgb-form-group {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .wme-usgb-panel .usgb-form-label {
        font-size: 11px;
        font-weight: 600;
        color: var(--content_p1);
        text-transform: uppercase;
        letter-spacing: 0.4px;
        display: flex;
        align-items: center;
        gap: 5px;
      }

      .wme-usgb-panel .usgb-tooltip-icon {
        width: 14px;
        height: 14px;
        background: var(--surface_variant);
        border-radius: 50%;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 9px;
        color: var(--content_p2);
        cursor: help;
        transition: all 150ms;
      }

      .wme-usgb-panel .usgb-tooltip-icon:hover {
        background: var(--primary);
        color: white;
        transform: scale(1.1);
      }

      .wme-usgb-panel .usgb-color-group {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
      }

      .wme-usgb-panel .usgb-color-picker-display {
        width: 100%;
        height: 40px;
        border-radius: 7px;
        border: 2px solid var(--hairline);
        cursor: pointer;
        transition: all 150ms;
        position: relative;
        overflow: hidden;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
      }

      .wme-usgb-panel .usgb-color-picker-display:hover {
        border-color: var(--primary);
        transform: scale(1.02);
      }

      .wme-usgb-panel .usgb-color-picker-display::after {
        content: attr(data-color);
        position: absolute;
        bottom: 3px;
        right: 5px;
        font-size: 9px;
        font-family: 'JetBrains Mono', monospace;
        font-weight: 500;
        color: white;
        background: rgba(0, 0, 0, 0.5);
        padding: 2px 5px;
        border-radius: 3px;
        backdrop-filter: blur(4px);
      }

      .wme-usgb-panel .usgb-slider-group {
        display: flex;
        align-items: center;
        gap: 10px;
      }

      .wme-usgb-panel .usgb-slider-wrapper {
        flex: 1;
        position: relative;
      }

      .wme-usgb-panel .usgb-slider {
        -webkit-appearance: none;
        appearance: none;
        width: 100%;
        height: 5px;
        border-radius: 3px;
        background: linear-gradient(to right, #4a90e2 0%, #4a90e2 60%, #e1e4e8 60%, #e1e4e8 100%);
        outline: none;
        cursor: pointer;
      }

      .wme-usgb-panel .usgb-slider::-webkit-slider-runnable-track {
        width: 100%;
        height: 5px;
        cursor: pointer;
        background: transparent;
      }

      .wme-usgb-panel .usgb-slider::-moz-range-track {
        width: 100%;
        height: 5px;
        cursor: pointer;
        background: transparent;
        border: none;
      }

      .wme-usgb-panel .usgb-slider::-webkit-slider-thumb {
        -webkit-appearance: none;
        appearance: none;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: var(--primary);
        cursor: pointer;
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.15);
        transition: all 150ms;
        margin-top: -5.5px;
      }

      .wme-usgb-panel .usgb-slider::-webkit-slider-thumb:hover {
        transform: scale(1.2);
      }

      .wme-usgb-panel .usgb-slider::-moz-range-thumb {
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: var(--primary);
        cursor: pointer;
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.15);
        border: none;
        transition: all 150ms;
      }

      .wme-usgb-panel .usgb-slider-value {
        min-width: 44px;
        height: 28px;
        background: var(--surface_variant);
        border: 1px solid var(--hairline);
        border-radius: 5px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: 'JetBrains Mono', monospace;
        font-size: 12px;
        font-weight: 500;
        color: var(--content_default);
      }

      .wme-usgb-panel .usgb-slider-presets {
        display: flex;
        gap: 4px;
        margin-top: 5px;
      }

      .wme-usgb-panel .usgb-slider-preset {
        flex: 1;
        padding: 3px 6px;
        font-size: 10px;
        background: var(--surface_variant);
        border: 1px solid var(--hairline);
        border-radius: 4px;
        cursor: pointer;
        text-align: center;
        transition: all 150ms;
        font-weight: 500;
      }

      .wme-usgb-panel .usgb-slider-preset:hover {
        background: var(--primary);
        color: white;
        border-color: var(--primary);
      }

      .wme-usgb-panel .usgb-form-group:has(.usgb-input-number) {
        flex-direction: row;
        align-items: center;
        gap: 10px;
      }

      .wme-usgb-panel .usgb-form-group:has(.usgb-input-number) .usgb-form-label {
        margin: 0;
      }

      .wme-usgb-panel .usgb-input-number {
        width: 70px;
        height: 32px;
        padding: 0 8px;
        border: 2px solid var(--hairline);
        border-radius: 7px;
        font-family: 'JetBrains Mono', monospace;
        font-size: 13px;
        color: var(--content_default);
        background: var(--surface_default);
        transition: all 150ms;
        flex-shrink: 0;
      }

      .wme-usgb-panel .usgb-input-number:focus {
        outline: none;
        border-color: var(--primary);
        box-shadow: 0 0 0 3px rgba(74, 144, 226, 0.1);
      }

      .wme-usgb-panel .usgb-checkbox-wrapper {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px;
        background: var(--surface_variant);
        border-radius: 7px;
        cursor: pointer;
        transition: all 150ms;
      }

      .wme-usgb-panel .usgb-checkbox-wrapper:hover {
        background: var(--surface_default);
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
      }

      .wme-usgb-panel .usgb-checkbox-input {
        position: relative;
        width: 18px;
        height: 18px;
        cursor: pointer;
      }

      .wme-usgb-panel .usgb-checkbox-input input {
        opacity: 0;
        position: absolute;
      }

      .wme-usgb-panel .usgb-checkbox-custom {
        width: 18px;
        height: 18px;
        border: 2px solid var(--hairline);
        border-radius: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--surface_default);
        transition: all 150ms;
      }

      .wme-usgb-panel .usgb-checkbox-input input:checked + .usgb-checkbox-custom {
        background: var(--primary);
        border-color: var(--primary);
      }

      .wme-usgb-panel .usgb-checkbox-custom i {
        color: white;
        font-size: 11px;
        opacity: 0;
        transform: scale(0);
        transition: all 150ms;
      }

      .wme-usgb-panel .usgb-checkbox-input input:checked + .usgb-checkbox-custom i {
        opacity: 1;
        transform: scale(1);
      }

      .wme-usgb-panel .usgb-checkbox-label {
        font-size: 13px;
        color: var(--content_default);
        flex: 1;
      }

      .wme-usgb-panel .usgb-btn {
        height: 36px;
        padding: 0 16px;
        border: none;
        border-radius: 7px;
        font-family: 'Rubik', sans-serif;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        transition: all 150ms;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        letter-spacing: 0.2px;
      }

      .wme-usgb-panel .usgb-btn-primary {
        background: linear-gradient(135deg, var(--primary) 0%, #357abd 100%);
        color: white;
        box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05);
      }

      .wme-usgb-panel .usgb-btn-primary:hover {
        transform: translateY(-1px);
        box-shadow: 0 10px 15px rgba(0, 0, 0, 0.08);
      }

      .wme-usgb-panel .usgb-btn-primary:disabled {
        opacity: 0.5;
        cursor: not-allowed;
        transform: none !important;
      }

      .wme-usgb-panel .usgb-btn-secondary {
        background: var(--surface_default);
        color: var(--content_default);
        border: 2px solid var(--hairline);
      }

      .wme-usgb-panel .usgb-btn-secondary:hover {
        border-color: var(--primary);
        color: var(--primary);
        transform: translateY(-1px);
      }

      .wme-usgb-panel .usgb-usps-section {
        background: var(--surface_default);
        border-radius: 10px;
        padding: 14px;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
        margin-bottom: 10px;
      }

      .wme-usgb-panel .usgb-usps-header {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 14px;
        padding-bottom: 12px;
        border-bottom: 2px solid var(--separator);
      }

      .wme-usgb-panel .usgb-usps-icon {
        width: 36px;
        height: 36px;
        background: linear-gradient(135deg, #ff6e40 0%, #ff8a65 100%);
        border-radius: 8px;
        display: flex;
        align-items: center;
        justify-content: center;
        color: white;
        font-size: 16px;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
      }

      .wme-usgb-panel .usgb-usps-title {
        font-size: 15px;
        font-weight: 600;
        color: var(--content_default);
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .wme-usgb-panel .usgb-usps-actions {
        display: flex;
        gap: 8px;
        margin-top: 12px;
      }

      .wme-usgb-panel .usgb-usps-results {
        margin-top: 12px;
        padding: 12px;
        background: var(--surface_variant);
        border-radius: 7px;
        min-height: 50px;
        display: flex;
        flex-direction: column;
        align-items: stretch;
        justify-content: flex-start;
      }

      .wme-usgb-panel .usgb-usps-results:empty {
        align-items: center;
        justify-content: center;
      }

      .wme-usgb-panel .usgb-usps-results:empty::before {
        content: 'No routes loaded';
        color: var(--content_p3);
        font-size: 12px;
        font-style: italic;
      }

      .wme-usgb-panel .usgb-loading-wrapper {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 12px;
        padding: 20px;
      }

      .wme-usgb-panel .usgb-loading-text {
        font-size: 13px;
        color: var(--content_p2);
        font-weight: 500;
      }

      .wme-usgb-panel .usgb-route-item {
        padding: 8px 12px;
        background: var(--surface_default);
        border-radius: 5px;
        margin-bottom: 6px;
        display: flex;
        align-items: center;
        gap: 8px;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
        animation: usgb-slideIn 0.3s cubic-bezier(0.68, -0.55, 0.265, 1.55);
      }

      .wme-usgb-panel .usgb-route-item:last-child {
        margin-bottom: 0;
      }

      @keyframes usgb-slideIn {
        from {
          opacity: 0;
          transform: translateX(-20px);
        }
        to {
          opacity: 1;
          transform: translateX(0);
        }
      }

      .wme-usgb-panel .usgb-route-color {
        width: 10px;
        height: 10px;
        border-radius: 3px;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
      }

      .wme-usgb-panel .usgb-route-name {
        flex: 1;
        font-size: 13px;
        font-weight: 600;
        color: var(--content_default);
      }

      .wme-usgb-panel .usgb-loading-spinner {
        width: 36px;
        height: 36px;
        border: 3px solid var(--separator);
        border-top-color: var(--primary);
        border-radius: 50%;
        animation: usgb-spin 0.8s linear infinite;
      }

      @keyframes usgb-spin {
        to { transform: rotate(360deg); }
      }

      .wme-usgb-panel .usgb-footer-actions {
        margin-top: 12px;
        display: flex;
        justify-content: center;
      }

      .wme-usgb-panel .usgb-layer-card[data-layer="states"] {
        --accent-color: #536dfe;
        --accent-color-light: #7c8ff9;
      }

      .wme-usgb-panel .usgb-layer-card[data-layer="counties"] {
        --accent-color: #ff8a80;
        --accent-color-light: #ffab91;
      }

      .wme-usgb-panel .usgb-layer-card[data-layer="zips"] {
        --accent-color: #ff5252;
        --accent-color-light: #ff6e76;
      }

      .wme-usgb-panel .usgb-layer-card[data-layer="timeZones"] {
        --accent-color: #ff6e40;
        --accent-color-light: #ff8a65;
      }
    `;
    document.head.appendChild(styleEl);
  }

  /**
   * Builds a layer configuration card for the modern UI.
   * Creates an interactive card with:
   * - Layer visibility toggle
   * - Expandable/collapsible content
   * - Color pickers for boundary and label colors
   * - Opacity slider with preset buttons
   * - Optional dynamic labels checkbox
   * - Optional minimum zoom level input
   *
   * All changes immediately update settings, save to localStorage, and update the map.
   *
   * @param {string} layerKey - Layer identifier ('zips', 'counties', 'states', 'timeZones')
   * @param {string} displayName - Display name for the card header
   * @param {string} icon - Font Awesome icon class (e.g., 'fas fa-map-marker')
   * @param {Object} [opts={}] - Optional configuration
   * @param {boolean} [opts.showMinZoom=false] - Show minimum zoom level control
   * @param {boolean} [opts.showDynamicLabels=true] - Show dynamic labels checkbox
   * @returns {HTMLElement} Card DOM element with attached event listeners
   */
  function buildLayerCard(layerKey, displayName, icon, opts = {}) {
    const s = _settings.layers[layerKey];
    const { showMinZoom = false, showDynamicLabels = true } = opts;

    const card = document.createElement('div');
    card.className = 'usgb-layer-card';
    card.setAttribute('data-layer', layerKey);

    card.innerHTML = `
      <div class="usgb-layer-header">
        <div class="usgb-layer-title-group">
          <div class="usgb-layer-icon">
            <i class="${icon}"></i>
          </div>
          <div class="usgb-layer-title">
            ${displayName}
          </div>
        </div>
        <div class="usgb-layer-controls-inline">
          <div class="usgb-visibility-toggle ${s.visible ? 'active' : ''}"></div>
          <i class="fas fa-chevron-down usgb-expand-icon"></i>
        </div>
      </div>
      <div class="usgb-layer-content">
        <div class="usgb-layer-content-inner">
          <div class="usgb-settings-grid">
            ${
              showDynamicLabels
                ? `
            <div class="usgb-checkbox-wrapper">
              <label class="usgb-checkbox-input">
                <input type="checkbox" ${s.dynamicLabels ? 'checked' : ''} data-setting="dynamicLabels">
                <div class="usgb-checkbox-custom">
                  <i class="fas fa-check"></i>
                </div>
              </label>
              <span class="usgb-checkbox-label">
                Dynamic label positions
                <span class="usgb-tooltip-icon" title="Automatically position labels at optimal locations">
                  <i class="fas fa-question"></i>
                </span>
              </span>
            </div>
            `
                : ''
            }
            <div class="usgb-color-group">
              <div class="usgb-form-group">
                <label class="usgb-form-label">
                  Boundary Color
                  <span class="usgb-tooltip-icon" title="Color of the boundary lines">
                    <i class="fas fa-question"></i>
                  </span>
                </label>
                <div class="usgb-color-picker-display" style="background: ${s.color};" data-color="${s.color}">
                  <input type="color" value="${s.color}" data-setting="color" style="opacity: 0; position: absolute; pointer-events: none;">
                </div>
              </div>
              <div class="usgb-form-group">
                <label class="usgb-form-label">Label Outline</label>
                <div class="usgb-color-picker-display" style="background: ${s.labelOutlineColor};" data-color="${s.labelOutlineColor}">
                  <input type="color" value="${s.labelOutlineColor}" data-setting="labelOutlineColor" style="opacity: 0; position: absolute; pointer-events: none;">
                </div>
              </div>
            </div>
            <div class="usgb-form-group">
              <label class="usgb-form-label">
                Opacity
                <span class="usgb-tooltip-icon" title="Transparency level of the layer">
                  <i class="fas fa-question"></i>
                </span>
              </label>
              <div class="usgb-slider-group">
                <div class="usgb-slider-wrapper">
                  <input type="range" class="usgb-slider" min="0" max="1" step="0.05" value="${s.opacity}" data-setting="opacity" style="--value-percent: ${s.opacity * 100}%;">
                </div>
                <div class="usgb-slider-value">${Math.round(s.opacity * 100)}%</div>
              </div>
              <div class="usgb-slider-presets">
                <button class="usgb-slider-preset" data-value="0.25">25%</button>
                <button class="usgb-slider-preset" data-value="0.5">50%</button>
                <button class="usgb-slider-preset" data-value="0.75">75%</button>
                <button class="usgb-slider-preset" data-value="1">100%</button>
              </div>
            </div>
            ${
              showMinZoom
                ? `
            <div class="usgb-form-group">
              <label class="usgb-form-label">
                Minimum Zoom Level
                <span class="usgb-tooltip-icon" title="Layer will only display at or above this zoom level">
                  <i class="fas fa-question"></i>
                </span>
              </label>
              <input type="number" class="usgb-input-number" min="1" max="22" value="${s.minZoom}" data-setting="minZoom">
            </div>
            `
                : ''
            }
          </div>
        </div>
      </div>
    `;

    // Attach event listeners
    const header = card.querySelector('.usgb-layer-header');
    header.addEventListener('click', (e) => {
      if (!e.target.closest('.usgb-visibility-toggle')) {
        card.classList.toggle('expanded');
      }
    });

    const visibilityToggle = card.querySelector('.usgb-visibility-toggle');
    visibilityToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const isActive = visibilityToggle.classList.contains('active');
      visibilityToggle.classList.toggle('active');
      _settings.layers[layerKey].visible = !isActive;
      saveSettings();
      sdk.Map.setLayerVisibility({ layerName: LAYER_NAME_MAP[layerKey], visibility: !isActive });

      // Sync with SDK layer checkbox
      sdk.LayerSwitcher.setLayerCheckboxChecked({
        name: LAYER_CHECKBOX_NAME_MAP[layerKey],
        isChecked: !isActive,
      });

      fetchBoundaries();
    });

    // Color pickers
    card.querySelectorAll('.usgb-color-picker-display').forEach((display) => {
      display.addEventListener('click', () => {
        const input = display.querySelector('input[type="color"]');
        input.click();
      });

      const input = display.querySelector('input[type="color"]');
      input.addEventListener('change', (e) => {
        const setting = e.target.getAttribute('data-setting');
        const color = e.target.value;
        display.style.background = color;
        display.setAttribute('data-color', color);
        _settings.layers[layerKey][setting] = color;
        saveSettings();
        sdk.Map.redrawLayer({ layerName: LAYER_NAME_MAP[layerKey] });
      });
    });

    // Opacity slider
    const slider = card.querySelector('.usgb-slider[data-setting="opacity"]');
    if (slider) {
      // Initialize slider background
      updateSliderBackground(slider);

      slider.addEventListener('input', (e) => {
        const value = parseFloat(e.target.value);
        updateSliderBackground(e.target);
        _settings.layers[layerKey].opacity = value;
        sdk.Map.setLayerOpacity({ layerName: LAYER_NAME_MAP[layerKey], opacity: value });
        saveSettings();
      });

      // Preset buttons
      card.querySelectorAll('.usgb-slider-preset').forEach((btn) => {
        btn.addEventListener('click', () => {
          const value = parseFloat(btn.getAttribute('data-value'));
          slider.value = value;
          updateSliderBackground(slider);
          _settings.layers[layerKey].opacity = value;
          sdk.Map.setLayerOpacity({ layerName: LAYER_NAME_MAP[layerKey], opacity: value });
          saveSettings();
        });
      });
    }

    // Dynamic labels checkbox
    const dynamicLabelsCheckbox = card.querySelector('input[data-setting="dynamicLabels"]');
    if (dynamicLabelsCheckbox) {
      dynamicLabelsCheckbox.addEventListener('change', (e) => {
        _settings.layers[layerKey].dynamicLabels = e.target.checked;
        saveSettings();
        fetchBoundaries();
      });
    }

    // Min zoom input
    const minZoomInput = card.querySelector('input[data-setting="minZoom"]');
    if (minZoomInput) {
      minZoomInput.addEventListener('change', (e) => {
        _settings.layers[layerKey].minZoom = parseInt(e.target.value, 10);
        saveSettings();
        fetchBoundaries();
      });
    }

    return card;
  }

  /**
   * Applies a predefined style preset to all boundary layers.
   * Updates colors and/or opacity for all layers, saves settings, redraws layers, and re-fetches boundaries.
   *
   * Available presets:
   * - 'high-contrast': Bright primary colors with high opacity (90%)
   * - 'minimal': Existing colors with very low opacity (30%)
   * - 'colorblind': Scientific colorblind-friendly palette (IBM Design)
   * - 'night': Dark colors with medium opacity (70%)
   *
   * @param {string} presetName - Name of preset to apply
   */
  function applyPreset(presetName) {
    const presets = {
      'high-contrast': {
        message: 'Applied high contrast colors for better visibility',
        settings: {
          zips: { color: '#ff0000', opacity: 0.9 },
          counties: { color: '#ffff00', opacity: 0.9 },
          states: { color: '#0000ff', opacity: 0.9 },
          timeZones: { color: '#ff00ff', opacity: 0.9 },
        },
      },
      minimal: {
        message: 'Applied minimal styling with reduced opacity',
        settings: {
          zips: { opacity: 0.3 },
          counties: { opacity: 0.3 },
          states: { opacity: 0.3 },
          timeZones: { opacity: 0.3 },
        },
      },
      colorblind: {
        message: 'Applied colorblind-friendly palette',
        settings: {
          zips: { color: '#0173B2' },
          counties: { color: '#DE8F05' },
          states: { color: '#029E73' },
          timeZones: { color: '#CC78BC' },
        },
      },
      night: {
        message: 'Applied night mode with darker colors',
        settings: {
          zips: { color: '#8B0000', opacity: 0.7 },
          counties: { color: '#4B0082', opacity: 0.7 },
          states: { color: '#00008B', opacity: 0.7 },
          timeZones: { color: '#8B4513', opacity: 0.7 },
        },
      },
    };

    const preset = presets[presetName];
    if (preset) {
      Object.keys(preset.settings).forEach((layerKey) => {
        Object.keys(preset.settings[layerKey]).forEach((setting) => {
          _settings.layers[layerKey][setting] = preset.settings[layerKey][setting];
        });
        if (preset.settings[layerKey].opacity !== undefined) {
          sdk.Map.setLayerOpacity({ layerName: LAYER_NAME_MAP[layerKey], opacity: preset.settings[layerKey].opacity });
        }
        if (preset.settings[layerKey].color !== undefined) {
          sdk.Map.redrawLayer({ layerName: LAYER_NAME_MAP[layerKey] });
        }
      });
      saveSettings();

      // Refresh the UI to show new values
      setTimeout(() => {
        const tabPane = document.querySelector('[data-usgb-tab]');
        if (tabPane) {
          const container = tabPane.querySelector('.usgb-container');
          if (container) {
            const newContainer = buildMainUI();
            container.replaceWith(newContainer);
          }
        }
      }, 100);
    }
  }

  /**
   * Builds the complete modern UI interface with all controls and sections.
   * Creates the main DOM structure including:
   * - Gradient header with title and icon
   * - Quick preset chips (High Contrast, Minimal, Colorblind, Night Mode)
   * - Layer configuration cards for all boundary types
   * - USPS Routes section with search controls
   * - Footer with "Reset to Defaults" button
   *
   * Attaches all necessary event listeners for interactive controls.
   *
   * @returns {HTMLElement} Complete UI container element
   * @see buildLayerCard - Used to create individual layer cards
   */
  function buildMainUI() {
    const container = document.createElement('div');
    container.className = 'usgb-container';

    // Header
    const header = document.createElement('div');
    header.className = 'usgb-header';
    header.innerHTML = `
      <div class="usgb-header-content">
        <div class="usgb-header-title">
          <div class="usgb-header-icon">
            <i class="fas fa-map-marked-alt"></i>
          </div>
          <h1>US Government Boundaries</h1>
        </div>
        <div class="usgb-header-subtitle">Configure boundary layers & visualizations</div>
      </div>
    `;
    container.appendChild(header);

    // Quick Presets
    const presetsDiv = document.createElement('div');
    presetsDiv.className = 'usgb-quick-presets';
    presetsDiv.innerHTML = `
      <span class="usgb-presets-label">Quick Presets</span>
      <div class="usgb-preset-chips">
        <div class="usgb-preset-chip" data-preset="high-contrast">
          <i class="fas fa-adjust"></i> High Contrast
        </div>
        <div class="usgb-preset-chip" data-preset="minimal">
          <i class="fas fa-minus-circle"></i> Minimal
        </div>
        <div class="usgb-preset-chip" data-preset="colorblind">
          <i class="fas fa-eye"></i> Colorblind
        </div>
        <div class="usgb-preset-chip" data-preset="night">
          <i class="fas fa-moon"></i> Night Mode
        </div>
      </div>
    `;
    presetsDiv.querySelectorAll('.usgb-preset-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        applyPreset(chip.getAttribute('data-preset'));
      });
    });
    container.appendChild(presetsDiv);

    // Layer Cards
    container.appendChild(buildLayerCard('states', 'States', 'fas fa-flag-usa', { showDynamicLabels: false }));
    container.appendChild(buildLayerCard('counties', 'Counties', 'fas fa-map', { showMinZoom: true }));
    container.appendChild(buildLayerCard('zips', 'ZIP Codes', 'fas fa-hashtag', { showMinZoom: true }));
    container.appendChild(buildLayerCard('timeZones', 'Time Zones', 'fas fa-clock'));

    // USPS Routes Section
    const uspsSection = document.createElement('div');
    uspsSection.className = 'usgb-usps-section';

    uspsSection.innerHTML = `
      <div class="usgb-usps-header">
        <div class="usgb-usps-icon">
          <i class="fas fa-route"></i>
        </div>
        <div>
          <div class="usgb-usps-title">USPS Routes</div>
          <div class="usgb-header-subtitle" style="color: var(--content_p2); margin-left: 0;">Query postal delivery routes</div>
        </div>
      </div>
      <div class="usgb-settings-grid">
        <div class="usgb-form-group">
          <label class="usgb-form-label">
            Search Radius (miles)
            <span class="usgb-tooltip-icon" title="Radius around map center to search for routes">
              <i class="fas fa-question"></i>
            </span>
          </label>
          <input type="number" class="usgb-input-number" id="usgb-usps-radius" min="0.5" max="2" step="0.1" value="${_settings.uspsRoutes.radius}">
        </div>
        <div class="usgb-form-group">
          <label class="usgb-form-label">Opacity</label>
          <div class="usgb-slider-group">
            <div class="usgb-slider-wrapper">
              <input type="range" class="usgb-slider" id="usgb-usps-opacity" min="0" max="1" step="0.05" value="${_settings.uspsRoutes.opacity}" style="--value-percent: ${_settings.uspsRoutes.opacity * 100}%;">
            </div>
            <div class="usgb-slider-value">${Math.round(_settings.uspsRoutes.opacity * 100)}%</div>
          </div>
        </div>
      </div>
      <div class="usgb-usps-actions">
        <button class="usgb-btn usgb-btn-primary" id="usgb-get-routes" style="flex: 1;">
          <i class="fas fa-location-arrow"></i>
          Get USPS Routes
        </button>
        <button class="usgb-btn usgb-btn-secondary" id="usgb-clear-routes">
          <i class="fas fa-times"></i>
          Clear
        </button>
      </div>
      <div class="usgb-usps-results" id="usgb-usps-results"></div>
    `;
    container.appendChild(uspsSection);

    // Wire up USPS controls
    const radiusInput = uspsSection.querySelector('#usgb-usps-radius');
    radiusInput.addEventListener('change', () => {
      _settings.uspsRoutes.radius = parseFloat(radiusInput.value);
      saveSettings();
    });

    const uspsOpacitySlider = uspsSection.querySelector('#usgb-usps-opacity');
    // Initialize slider background
    updateSliderBackground(uspsOpacitySlider);

    uspsOpacitySlider.addEventListener('input', (e) => {
      const value = parseFloat(e.target.value);
      updateSliderBackground(e.target);
      _settings.uspsRoutes.opacity = value;
      sdk.Map.setLayerOpacity({ layerName: USPS_ROUTES_LAYER_NAME, opacity: value });
      saveSettings();
    });

    _$uspsResultsDiv = $(uspsSection.querySelector('#usgb-usps-results'));
    _$getRoutesButton = $(uspsSection.querySelector('#usgb-get-routes'));
    _$getRoutesButton.click(onGetRoutesButtonClick).mouseenter(onGetRoutesButtonMouseEnter).mouseout(onGetRoutesButtonMouseLeave);
    $(uspsSection.querySelector('#usgb-clear-routes')).click(onClearRoutesButtonClick);

    // Footer Actions
    const footerActions = document.createElement('div');
    footerActions.className = 'usgb-footer-actions';
    footerActions.innerHTML = `
      <button class="usgb-btn usgb-btn-secondary" id="usgb-reset-all">
        <i class="fas fa-redo"></i>
        Reset all to script defaults
      </button>
    `;

    footerActions.querySelector('#usgb-reset-all').addEventListener('click', () => {
      if (confirm('Are you sure you want to reset all settings to defaults?')) {
        _settings = getDefaultSettings();
        saveSettings();

        // Apply default opacities
        Object.keys(_settings.layers).forEach((layerKey) => {
          sdk.Map.setLayerOpacity({ layerName: LAYER_NAME_MAP[layerKey], opacity: _settings.layers[layerKey].opacity });
          sdk.Map.redrawLayer({ layerName: LAYER_NAME_MAP[layerKey] });
        });
        sdk.Map.setLayerOpacity({ layerName: USPS_ROUTES_LAYER_NAME, opacity: _settings.uspsRoutes.opacity });

        fetchBoundaries();

        // Rebuild UI
        setTimeout(() => {
          const tabPane = document.querySelector('[data-usgb-tab]');
          if (tabPane) {
            const oldContainer = tabPane.querySelector('.usgb-container');
            if (oldContainer) {
              const newContainer = buildMainUI();
              oldContainer.replaceWith(newContainer);
            }
          }
        }, 100);
      }
    });

    container.appendChild(footerActions);

    return container;
  }

  /**
   * Initializes the WME sidebar tab for this script.
   * Creates a custom "USGB" tab, injects the modern UI styles, and builds the UI.
   *
   * @async
   * @see initModernUI - Injects CSS styles
   * @see buildMainUI - Creates the UI DOM structure
   */
  function initTab() {
    initModernUI();

    sdk.Sidebar.registerScriptTab()
      .then(({ tabLabel, tabPane }) => {
        tabLabel.textContent = 'USGB';
        tabLabel.title = 'US Government Boundaries - Modern UI';
        tabPane.setAttribute('data-usgb-tab', 'true');
        tabPane.classList.add('wme-usgb-panel');
        tabPane.appendChild(buildMainUI());
      })
      .catch((error) => {
        logError(`Error creating script tab: ${error}`);
      });
  }

  /**
   * Toggles a layer's visibility and synchronizes all UI elements.
   * Updates:
   * - Internal settings
   * - Map layer visibility
   * - WME layer switcher checkbox
   * - Modern UI visibility toggle button
   * Then re-fetches boundaries to reflect the new state.
   *
   * @param {string} layerKey - Layer identifier ('zips', 'counties', 'states', 'timeZones')
   * @fires fetchBoundaries - Triggers boundary re-fetch
   */
  function toggleLayerVisibility(layerKey) {
    const newVisibility = !_settings.layers[layerKey].visible;
    _settings.layers[layerKey].visible = newVisibility;
    saveSettings();
    sdk.Map.setLayerVisibility({ layerName: LAYER_NAME_MAP[layerKey], visibility: newVisibility });

    // Sync with SDK layer checkbox
    sdk.LayerSwitcher.setLayerCheckboxChecked({
      name: LAYER_CHECKBOX_NAME_MAP[layerKey],
      isChecked: newVisibility,
    });

    // Sync with modern UI visibility toggle
    const layerCard = document.querySelector(`.usgb-layer-card[data-layer="${layerKey}"]`);
    if (layerCard) {
      const toggle = layerCard.querySelector('.usgb-visibility-toggle');
      if (toggle) {
        if (newVisibility) {
          toggle.classList.add('active');
        } else {
          toggle.classList.remove('active');
        }
      }
    }

    fetchBoundaries();
  }

  /**
   * Registers keyboard shortcuts with the SDK.
   * Uses stored shortcut values (default: null) so users can assign their own.
   * Handles duplicate key conflicts by resetting to no shortcut.
   */
  function registerShortcuts() {
    const shortcuts = [
      { id: 'usgb-toggle-zips', description: 'Toggle ZIP Codes layer', handler: () => toggleLayerVisibility('zips') },
      { id: 'usgb-toggle-counties', description: 'Toggle Counties layer', handler: () => toggleLayerVisibility('counties') },
      { id: 'usgb-toggle-states', description: 'Toggle States layer', handler: () => toggleLayerVisibility('states') },
      { id: 'usgb-toggle-timezones', description: 'Toggle Time Zones layer', handler: () => toggleLayerVisibility('timeZones') },
      { id: 'usgb-fetch-usps-routes', description: 'Fetch USPS Routes', handler: fetchUspsRoutesFeatures },
    ];

    let needsSave = false;

    shortcuts.forEach(({ id, description, handler }) => {
      try {
        // SDK expects combo format, not raw format
        const comboKeys = _settings.shortcuts[id]?.combo || null;

        sdk.Shortcuts.createShortcut({
          shortcutId: id,
          shortcutKeys: comboKeys, // Use combo format from storage (null by default)
          description,
          callback: handler,
        });
      } catch (e) {
        // Handle duplicate key conflicts by resetting to no shortcut
        if (e.message && e.message.includes('already in use')) {
          _settings.shortcuts[id] = { raw: null, combo: null };
          needsSave = true;

          // Try to register again with null (no shortcut)
          try {
            sdk.Shortcuts.createShortcut({
              shortcutId: id,
              shortcutKeys: null,
              description,
              callback: handler,
            });
          } catch (retryError) {
            logError(`Failed to register ${id} even with null keys: ${retryError.message}`);
          }
        } else {
          logError(`Failed to register ${id}: ${e.message}`);
        }
      }
    });

    // Save settings if any duplicates were reset
    if (needsSave) {
      saveSettings();
    }
  }

  // Save shortcut settings on page unload
  window.addEventListener('beforeunload', saveShortcutSettings);

  /**
   * Main initialization function for the script.
   * Called after Bootstrap SDK is ready. Orchestrates all setup operations:
   * 1. Loads settings from localStorage
   * 2. Registers keyboard shortcuts
   * 3. Initializes all map layers
   * 4. Creates the sidebar tab with UI
   * 5. Performs initial boundary fetch
   * 6. Shows update notification if script version changed
   *
   * @see loadSettings, registerShortcuts, initLayers, initTab, fetchBoundaries, showScriptInfoAlert
   */
  function init() {
    loadSettings();
    registerShortcuts();
    initLayers();
    initTab();
    showScriptInfoAlert();
    fetchBoundaries();
    log('Modern UI Initialized.');
  }

  // Expose debug functions globally
  window.USGB_Debug = {
    settings: () => _settings,
    shortcuts: () => _settings.shortcuts,
  };

  init();
})();
