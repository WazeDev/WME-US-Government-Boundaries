// ==UserScript==
// @name         WME US Government Boundaries (beta)
// @namespace    https://greasyfork.org/users/45389
// @version      0.4.7
// @description  Adds a layer to display US (federal, state, and/or local) boundaries.
// @author       MapOMatic
// @include      /^https:\/\/(www|beta)\.waze\.com\/(?!user\/)(.{2,6}\/)?editor\/?.*$/
// @grant        GM_xmlhttpRequest
// @license      GNU GPLv3
// @connect      census.gov
// @connect      wazex.us

// ==/UserScript==

/* global $ */
/* global OpenLayers */
/* global GM_info */
/* global W */
/* global GM_xmlhttpRequest */
/* global unsafeWindow */
/* global Waze */
/* global Components */
/* global I18n */

(function() {
    'use strict';

    var _settingsStoreName = 'wme_us_government_boundaries';
    var _alertUpdate = false;
    var _debugLevel = 0;
    var _scriptVersion = GM_info.script.version;
    var _scriptVersionChanges = [
        GM_info.script.name + '\nv' + _scriptVersion + '\n\nWhat\'s New\n------------------------------\n',
        '\n- Restored zip->city lookup.'
    ].join('');
    var _mapLayer = null;
    var _settings = {};
    var _lastCallToken = 0;

    function reverseStatesHash(stateAbbr) {
        for (var stateName in _statesHash) {
            if (_statesHash[stateName] == stateAbbr) return stateName;
        }
    }

    function log(message, level) {
        if (message && (!level || (level <= _debugLevel))) {
            console.log('US Boundaries: ', message);
        }
    }

    function loadSettingsFromStorage() {
        var loadedSettings = $.parseJSON(localStorage.getItem(_settingsStoreName));
        var defaultSettings = {
            lastVersion:null,
            layerVisible:true
        };
        _settings = loadedSettings ? loadedSettings : defaultSettings;
        for (var prop in defaultSettings) {
            if (!_settings.hasOwnProperty(prop)) {
                _settings[prop] = defaultSettings[prop];
            }
        }
    }

    function saveSettingsToStorage() {
        if (localStorage) {
            _settings.lastVersion = _scriptVersion;
            //TODO - save layer checkbox visibility
            localStorage.setItem(_settingsStoreName, JSON.stringify(_settings));
            log('Settings saved', 1);
        }
    }

    function getAsync(url, context) {
        return new Promise(function(resolve, reject) {
            GM_xmlhttpRequest({
                context:context, method:"GET", url:url,
                onload:function(res) {
                    if (res.status == 200) {
                        resolve({responseText: res.responseText, context:context});
                    } else {
                        reject({responseText: res.responseText, context:context});
                    }
                },
                onerror: function() {
                    reject(Error("Network Error"));
                }
            });
        });
    }

    function getUrl(extent, zoom) {
        var whereParts = [];
        var geometry = { xmin:extent.left, ymin:extent.bottom, xmax:extent.right, ymax:extent.top, spatialReference: {wkid: 102100, latestWkid: 3857} };
        var geometryStr = JSON.stringify(geometry);
        var offsets = [40,20,10,4,2,1,0.5,0.25,0.125,0.0625,0.03125];
        var url = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/PUMA_TAD_TAZ_UGA_ZCTA/MapServer/4/query?geometry=' + encodeURIComponent(geometryStr);
        url += '&returnGeometry=true';
        //url += '&maxAllowableOffset=' + offsets[zoom];
        url += '&outFields=' + encodeURIComponent('ZCTA5');
        url += '&quantizationParameters={tolerance:100}';
        url += '&spatialRel=esriSpatialRelIntersects&geometryType=esriGeometryEnvelope&inSR=102100&outSR=3857&f=json';
        return url;
    }

    function appendCityToZip(html, token) {
        if (_lastCallToken === token) {
            var city = /<City>(.*?)<\/City>/.exec(html);
            if (city.length === 2) {
                city = city[1];
                var state =  /<State>(.*?)<\/State>/.exec(html);
                if (state.length === 2) {
                    state = state[1];
                    $('#zip-text').append(' (' + city + ', ' + state + ')');
                }
            }
        }
    }

    function updateNameDisplay(token){
        if (_mapLayer !== null) {
            var mapCenter = new OpenLayers.Geometry.Point(W.map.center.lon,W.map.center.lat);
            for (var i=0;i<_mapLayer.features.length;i++){
                var feature = _mapLayer.features[i];
                var color;
                var text = '';
                var num;
                var url;
                if(feature.geometry.containsPoint(mapCenter)) {
                    num = feature.attributes.name;
                    text = 'ZIP: ' + num;
                    //color = _colorLookup['IN-' + feature.attributes.name].fillColor;
                    var $div = $('<div>', {id:'zip-boundary', class:"us-boundary-region", style:'float:left ;margin-left:10px;'}).css({color:'white'});
                    var $span = $('<span>', {id:'zip-text'}).css({display:'inline-block'});
                    url = 'https://tools.usps.com/go/ZipLookupResultsAction!input.action?resultMode=2&companyName=&address1=&address2=&city=&state=Select&urbanCode=&postalCode=' + num + '&zip=';
                    $span.append($('<a>', {href:url, target:'__blank', title:'Look up USPS zip code'}).text(text).css({color:'white',display:'inline-block'}));
                    GM_xmlhttpRequest({
                        url: 'https://wazex.us/zips/ziptocity.php?zip=' + num,
                        context: {token:token},
                        method: 'GET',
                        onload: function(res) {appendCityToZip(res.responseText, res.context.token);}
                    });
                    $span.appendTo($div);
                    $('.loading-indicator-region').before($div);
                }
            }
        }
    }

    function processBoundaries(states, token) {
        _mapLayer.removeAllFeatures();
        states.forEach(function(state) {
            var attributes = {
                name: state.attributes.ZCTA5
            };

            var rings = [];
            state.geometry.rings.forEach(function(ringIn) {
                var pnts= [];
                for(var i=0;i<ringIn.length;i++){
                    pnts.push(new OpenLayers.Geometry.Point(ringIn[i][0], ringIn[i][1]));
                }
                rings.push(new OpenLayers.Geometry.LinearRing(pnts));
            });
            var polygon = new OpenLayers.Geometry.Polygon(rings);
            var feature = new OpenLayers.Feature.Vector(polygon,attributes);
            _mapLayer.addFeatures([feature]);
        });
        if (_lastCallToken === token) {
            updateNameDisplay(token);
        }
    }

    function fetchBoundaries() {
        var url = getUrl(Waze.map.getExtent(), Waze.map.getZoom());
        var context = {token:++_lastCallToken};
        $('.us-boundary-region').remove();
        $.ajax({
            url: url,
            context: context,
            method: 'GET',
            datatype: 'json',
            success: function(data) {processBoundaries($.parseJSON(data).features, this.token); }
        });
    }

    function onLayerVisibilityChanged(evt) {
        _settings.layerVisible = _mapLayer.visibility;
        saveSettingsToStorage();
    }

    function onModeChanged(model, modeId, context) {
        if(!modeId || modeId === 1) {
            initUserPanel();
        }
    }

    function onLayerToggleChanged(checked) {
        _mapLayer.setVisibility(checked);
    }

    function showScriptInfoAlert() {
        /* Check version and alert on update */
        if (_alertUpdate && _scriptVersion !== _settings.lastVersion) {
            alert(_scriptVersionChanges);
        }
    }

    function initLayer(){
        var _drawingContext = {
            getZIndex: function(feature) {
                return feature.attributes.zIndex;
            },
            getStrokeWidth: function() { return getLineWidth(); }
        };

        var defaultStyle = {
            strokeColor: '#ff0000',
            strokeOpacity: 1,
            strokeWidth: 3,
            strokeDashstyle: 'solid',
            fillOpacity: 0,
            label : "${name}",
            fontSize: "16px",
            fontFamily: "Courier New, monospace",
            fontWeight: "bold",
            fontColor: "red",
            //labelAlign: "${align}",
            //labelXOffset: "${xOffset}",
            //labelYOffset: "${yOffset}",
            labelOutlineColor: "white",
            labelOutlineWidth: 2
        };
        _mapLayer = new OpenLayers.Layer.Vector("US Gov't Boundaries", {
            uniqueName: "__WMEUSBoundaries",
            displayInLayerSwitcher: true,
            styleMap: new OpenLayers.StyleMap({
                default: defaultStyle,
            })
        });

        _mapLayer.setOpacity(0.8);

        //I18n.translations.en.layers.name.__FCLayer = "US Government Boundaries";

        _mapLayer.setOpacity(0.6);
        _mapLayer.displayInLayerSwitcher = true;
        _mapLayer.events.register('visibilitychanged',null,onLayerVisibilityChanged);
        _mapLayer.setVisibility(true); //_settings.layerVisible);

        Waze.map.addLayer(_mapLayer);

        Waze.map.events.register("moveend",Waze.map,function(e){
            fetchBoundaries();
            return true;
        },true);

        // Add the layer checkbox to the Layers menu.
        //WazeWrapBeta.Interface.AddLayerCheckbox("display", "US Govt Boundaries", _settings.layerVisible, onLayerToggleChanged);
    }

    function initGui() {
        initLayer();
        showScriptInfoAlert();
    }

    function init() {
        loadSettingsFromStorage();
        String.prototype.replaceAll = function(search, replacement) {
            var target = this;
            return target.replace(new RegExp(search, 'g'), replacement);
        };
        initGui();
        fetchBoundaries();
        log('Initialized.', 1);
    }

    function bootstrap() {
        if (Waze && Waze.loginManager &&
            Waze.loginManager.events &&
            Waze.loginManager.events.register &&
            Waze.model && Waze.model.states && Waze.model.states.additionalInfo &&
            Waze.map && Waze.loginManager.isLoggedIn() //&&
            /*WazeWrapBeta.Interface*/ ) {
            log('Initializing...', 1);

            init();
        } else {
            log('Bootstrap failed. Trying again...', 1);
            setTimeout(function () {
                bootstrap();
            }, 1000);
        }
    }

    log('Bootstrap...', 1);
    bootstrap();
})();
