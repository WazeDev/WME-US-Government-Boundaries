// ==UserScript==
// @name            WME US Government Boundaries
// @namespace       https://greasyfork.org/users/45389
// @version         2018.12.28.001
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
/* global unsafeWindow */
/* global Components */
/* global I18n */
/* global turf */
/* global WazeWrap */

(function() {
    'use strict';

    var SETTINGS_STORE_NAME = 'wme_us_government_boundaries';
    var ALERT_UPDATE = false;
    var ZIPS_LAYER_URL = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/PUMA_TAD_TAZ_UGA_ZCTA/MapServer/4/';
    var COUNTIES_LAYER_URL = 'https://tigerweb.geo.census.gov/arcgis/rest/services/Census2010/State_County/MapServer/1/';
    const USPS_ROUTE_COLORS = ['#f00','#0a0','#00f','#a0a','#6c82cb','#0aa'];
    const USPS_ROUTES_URL_TEMPLATE = 'https://gis.usps.com/arcgis/rest/services/EDDM/selectNear/GPServer/routes/execute?f=json&env%3AoutSR=102100&' +
          'Selecting_Features=%7B%22geometryType%22%3A%22esriGeometryPoint%22%2C%22features%22%3A%5B%7B%22geometry%22%3A%7B%22x%22%3A{lon}%2C%22y%22%3A{lat}' +
          '%2C%22spatialReference%22%3A%7B%22wkid%22%3A102100%2C%22latestWkid%22%3A3857%7D%7D%7D%5D%2C%22sr%22%3A%7B%22wkid%22%3A102100%2C%22latestWkid%22%3A3857%7D%7D&' +
          'Distance={radius}&Rte_Box=R&userName=EDDM';

    var _scriptVersion = GM_info.script.version;
    var _scriptVersionChanges = [
        GM_info.script.name + '\nv' + _scriptVersion + '\n\nWhat\'s New\n------------------------------\n',
        '\n- Restored zip->city lookup.'
    ].join('');
    var _zipsLayer;
    var _countiesLayer;
    let _uspsRoutesMapLayer = null;
    let _uspsRoutesradius = 0.5; // miles
    let _circleFeature;
    let _$resultsDiv;
    let _$getRoutesButton;
    var _settings = {};
    const STATES = {
        _states:[
            ['US (Country)','US',-1],['Alabama','AL',1],['Alaska','AK',2],['American Samoa','AS',60],['Arizona','AZ',4],['Arkansas','AR',5],['California','CA',6],['Colorado','CO',8],['Connecticut','CT',9],['Delaware','DE',10],['District of Columbia','DC',11],
            ['Florida','FL',12],['Georgia','GA',13],['Guam','GU',66],['Hawaii','HI',15],['Idaho','ID',16],['Illinois','IL',17],['Indiana','IN',18],['Iowa','IA',19],['Kansas','KS',20],
            ['Kentucky','KY',21],['Louisiana','LA',22],['Maine','ME',23],['Maryland','MD',24],['Massachusetts','MA',25],['Michigan','MI',26],['Minnesota','MN',27],['Mississippi','MS',28],['Missouri','MO',29],
            ['Montana','MT',30],['Nebraska','NE',31],['Nevada','NV',32],['New Hampshire','NH',33],['New Jersey','NJ',34],['New Mexico','NM',35],['New York','NY',36],['North Carolina','NC',37],['North Dakota','ND',38],
            ['Northern Mariana Islands','MP',69],['Ohio','OH',39],['Oklahoma','OK',40],['Oregon','OR',41],['Pennsylvania','PA',42],['Puerto Rico','PR',72],['Rhode Island','RI',44],['South Carolina','SC',45],
            ['South Dakota','SD',46],['Tennessee','TN',47],['Texas','TX',48],['Utah','UT',49],['Vermont','VT',50],['Virgin Islands','VI',78],['Virginia','VA',51],['Washington','WA',53],['West Virginia','WV',54],['Wisconsin','WI',55],['Wyoming','WY',56]
        ],
        toAbbr: function(fullName) { return this._states.find(a => a[0] === fullName)[1]; },
        toFullName: function(abbr) { return this._states.find(a => a[1] === abbr)[0]; },
        toFullNameArray: function() { return this._states.map(a => a[0]); },
        toAbbrArray: function() { return this._states.map(a => a[1]); },
        fromId: function(id) { return this._states.find(a => a[2] === id); }
    };

    function log(message) {
        console.log('USGB:', message);
    }

    // Recursively checks the settings object and fills in missing properties from the default settings object.
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
        var loadedSettings = $.parseJSON(localStorage.getItem(SETTINGS_STORE_NAME));
        var defaultSettings = {
            lastVersion:null,
            layers: {
                zips: { visible: true, dynamicLabels: false },
                counties: { visible: true, dynamicLabels: true, showState: true }
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
            _settings.lastVersion = _scriptVersion;
            _settings.layers.zips.visible = _zipsLayer.visibility;
            _settings.layers.counties.visible = _countiesLayer.visibility;
            localStorage.setItem(SETTINGS_STORE_NAME, JSON.stringify(_settings));
            log('Settings saved');
        }
    }

    function getUrl(baseUrl, extent, zoom, outFields) {
        var geometry = { xmin:extent.left, ymin:extent.bottom, xmax:extent.right, ymax:extent.top, spatialReference: {wkid: 102100, latestWkid: 3857} };
        var geometryStr = JSON.stringify(geometry);
        var url = baseUrl + 'query?geometry=' + encodeURIComponent(geometryStr);
        url += '&returnGeometry=true';
        url += '&outFields=' + encodeURIComponent(outFields.join(','));
        url += '&quantizationParameters={tolerance:100}';
        url += '&spatialRel=esriSpatialRelIntersects&geometryType=esriGeometryEnvelope&inSR=102100&outSR=3857&f=json';
        return url;
    }

    var _zipCities = {};
    function appendCityToZip(zip, cityState, context) {
        if (!context.cancel) {
            if (!cityState.error) {
                _zipCities[zip] = cityState;
                $('#zip-text').append(' (' + cityState.city + ', ' + cityState.state + ')');
            }
        }
    }

    function updateNameDisplay(context){
        var center = W.map.getCenter();
        var mapCenter = new OL.Geometry.Point(center.lon,center.lat);
        var feature;
        var text = '';
        var label;
        var url;
        var i;
        if (context.cancel) return;
        if (_zipsLayer && _zipsLayer.visibility) {
            for (i=0;i<_zipsLayer.features.length;i++){
                feature = _zipsLayer.features[i];

                if(feature.geometry.containsPoint && feature.geometry.containsPoint(mapCenter)) {
                    text = feature.attributes.name;
                    url = 'https://tools.usps.com/go/ZipLookupResultsAction!input.action?resultMode=2&companyName=&address1=&address2=&city=&state=Select&urbanCode=&postalCode=' + text + '&zip=';
                    $('<span>', {id:'zip-text'}).empty().css({display:'inline-block'}).append(
                        $('<a>', {href:url, target:'__blank', title:'Look up USPS zip code'})
                        .text(text)
                        .css({color:'white',display:'inline-block'})
                    ).appendTo($('#zip-boundary'));
                    if (!context.cancel) {
                        if (_zipCities[text]) {
                            appendCityToZip(text, _zipCities[text], context);
                        } else {
                            GM_xmlhttpRequest({
                                url: 'https://wazex.us/zips/ziptocity2.php?zip=' + text,
                                context: context,
                                method: 'GET',
                                onload: function(res) {appendCityToZip(text, $.parseJSON(res.responseText), res.context);}
                            });
                        }
                    }
                }
            }
        }
        if (_countiesLayer && _countiesLayer.visibility) {
            for (i=0;i<_countiesLayer.features.length;i++){
                feature = _countiesLayer.features[i];
                if(feature.attributes.type !== 'label' && feature.geometry.containsPoint(mapCenter)) {
                    label = feature.attributes.name;
                    $('<span>', {id:'county-text'}).css({display:'inline-block'})
                        .text(label)
                        .appendTo($('#county-boundary'));
                }
            }
        }
    }

    function arcgisFeatureToOLFeature(feature, attributes) {
        var rings = [];
        feature.geometry.rings.forEach(function(ringIn) {
            var pnts= [];
            for(var i=0;i<ringIn.length;i++){
                pnts.push(new OL.Geometry.Point(ringIn[i][0], ringIn[i][1]));
            }
            rings.push(new OL.Geometry.LinearRing(pnts));
        });
        var polygon = new OL.Geometry.Polygon(rings);
        return new OL.Feature.Vector(polygon, attributes);
    }

    function getRingArrayFromFeature(feature) {
        var rings = [];
        feature.geometry.components.forEach(function(featureRing) {
            var ring = [];
            featureRing.components.forEach(function(pt) {
                ring.push([pt.x, pt.y]);
            });
            rings.push(ring);
        });
        return rings;
    }

    function getLabelPoints(feature) {
        var e = W.map.getExtent();
        var screenPoly = turf.polygon([[[e.left, e.top], [e.right, e.top], [e.right, e.bottom], [e.left, e.bottom], [e.left, e.top]]]);
        // The intersect function doesn't seem to like holes in polygons, so assume the first ring is the outer boundary and ignore any holes.
        var featurePoly = turf.polygon([getRingArrayFromFeature(feature)[0]]);
        var intersection = turf.intersect(screenPoly, featurePoly);

        if (intersection && intersection.geometry && intersection.geometry.coordinates) {
            var turfPt = turf.centerOfMass(intersection);
            if (!turf.inside(turfPt,intersection)) {
                turfPt = turf.pointOnSurface(intersection);
            }
            var turfCoords = turfPt.geometry.coordinates;
            var pt = new OL.Geometry.Point(turfCoords[0], turfCoords[1]);
            var attributes = feature.attributes;
            attributes.label = feature.attributes.name; //featureArea/screenArea;
            return [new OL.Feature.Vector(pt, attributes)];
        }
    }

    function processBoundaries(boundaries, context, type, nameField, labelFunc) {
        var layer;
        var layerSettings;
        switch(type) {
            case 'zip':
                layerSettings = _settings.layers.zips;
                layer = _zipsLayer;
                break;
            case 'county':
                layerSettings = _settings.layers.counties;
                layer = _countiesLayer;
                break;
        }

        if (context.cancel || !layerSettings.visible) {
            // do nothing
        } else {
            layer.removeAllFeatures();
            if (!context.cancel) {
                boundaries.forEach(function(boundary) {
                    var label = labelFunc(boundary);
                    var attributes = {
                        name: label,
                        label: layerSettings.dynamicLabels ? '' : label,
                        type: type
                    };

                    if (!context.cancel) {
                        var feature = arcgisFeatureToOLFeature(boundary, attributes);
                        layer.addFeatures([feature]);
                        if (layerSettings.dynamicLabels) {
                            var labels = getLabelPoints(feature);
                            if (labels) {
                                labels.forEach(function(labelFeature) {
                                    labelFeature.attributes.type='label';
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
            var idx = _processContexts.indexOf(context);
            if (idx > -1) {
                _processContexts.splice(idx, 1);
            }
        }
    }
       function getUspsRoutesUrl(lon, lat, radius) {
        return USPS_ROUTES_URL_TEMPLATE.replace('{lon}', lon).replace('{lat}', lat).replace('{radius}', radius);
    }

    function getCircleLinearRing() {
        let center = W.map.getCenter();
        let radius = _uspsRoutesradius * 1609.344; // miles to meters
        let points = [];

        for(let degree = 0; degree < 360; degree += 5){
            let radians = degree * Math.PI/180;
            let lon = center.lon + radius * Math.cos(radians);
            let lat = center.lat + radius * Math.sin(radians);
            points.push(new OL.Geometry.Point(lon, lat));
        }
        return new OL.Geometry.LinearRing(points);
    }

    function processUspsRoutesResponse(res) {
        let data = $.parseJSON(res.responseText);
        let routes = data.results[0].value.features;

        let zipRoutes = {};
        routes.forEach(route => {
            let id = route.attributes.CITY_STATE + ' ' + route.attributes.ZIP_CODE;
            let zipRoute = zipRoutes[id];
            if (!zipRoute) {
                zipRoute = {paths:[]};
                zipRoutes[id] = zipRoute;
            }
            zipRoute.paths = zipRoute.paths.concat(route.geometry.paths);
        });

        let features = [];
        let routeIdx = 0;

        _$resultsDiv.empty();
        Object.keys(zipRoutes).forEach(zipName => {
            var paths = []
            let route = zipRoutes[zipName];
            route.paths.forEach(function(path){
                var pointList = [];
                path.forEach(function(point){
                    pointList.push(new OL.Geometry.Point(point[0],point[1]));
                });
                paths.push( new OL.Geometry.LineString(pointList));
            });
            let color = USPS_ROUTE_COLORS[routeIdx];
            let style = {
                strokeColor: color,
                strokeDashstyle: "solid",
                strokeWidth: 18
            };
            features.push( new OL.Feature.Vector(
                new OL.Geometry.MultiLineString(paths), null, style
            ));
            _$resultsDiv.append($('<div>').text(zipName).css({color: color, fontWeight: 'bold'}));
            routeIdx++;
        });
        _$getRoutesButton.removeAttr('disabled').css({color:'#000'});
        _uspsRoutesMapLayer.addFeatures(features);
    }

    function fetchUspsRoutesFeatures() {
        let center = W.map.getCenter();
        let url = getUspsRoutesUrl(center.lon, center.lat, _uspsRoutesradius);

        _$getRoutesButton.attr('disabled', 'true').css({color:'#888'});
        _$resultsDiv.empty().append('<i class="fa fa-spinner fa-pulse fa-3x fa-fw"></i>');
        _uspsRoutesMapLayer.removeAllFeatures();
        GM_xmlhttpRequest({ url: url, onload: processUspsRoutesResponse});
    }



    var _processContexts = [];

    function getZipLabel(feature) {
        return feature.attributes['ZCTA5'];
    }
    function getCountyLabel(feature) {
        let label = feature.attributes['NAME'];
        if (_settings.layers.counties.showState) {
            let stateId = parseInt(feature.attributes['STATE']);
            label += ', ' + STATES.fromId(stateId)[1];
        }
        return label;
    }

    function fetchBoundaries() {
        if (_processContexts.length > 0) {
            _processContexts.forEach(function(context) {context.cancel = true;});
        }

        var extent = W.map.getExtent();
        var zoom = W.map.getZoom();
        var url;
        var context = {callCount:0, cancel:false};
        _processContexts.push(context);
        $('.us-boundary-region').remove();
        $('.loading-indicator-region').before(
            $('<div>', {id:'county-boundary', class:"us-boundary-region"}).css({color:'white', float:'left', marginLeft:'10px'}),
            $('<div>', {id:'zip-boundary', class:"us-boundary-region"}).css({color:'white', float:'left', marginLeft:'10px'})
        );
        if (_settings.layers.zips.visible) {
            url = getUrl(ZIPS_LAYER_URL, extent, zoom, ['ZCTA5']);
            context.callCount++;
            $.ajax({
                url: url,
                context: context,
                method: 'GET',
                datatype: 'json',
                success: function(data) {processBoundaries($.parseJSON(data).features, this, 'zip', 'ZCTA5', getZipLabel); }
            });
        }
        if (_settings.layers.counties.visible) {
            url = getUrl(COUNTIES_LAYER_URL, extent, zoom, ['NAME','STATE']);
            context.callCount++;
            $.ajax({
                url: url,
                context: context,
                method: 'GET',
                datatype: 'json',
                success: function(data) {processBoundaries($.parseJSON(data).features, this, 'county', 'NAME', getCountyLabel); }
            });
        }
    }

    // function fetchTimeZone() {
    //     let center = W.map.getCenter();
    //     center.transform(W.map.projection, W.map.displayProjection);
    //     var dt = new Date();
    //     $.ajax({
    //         url: 'https://maps.googleapis.com/maps/api/timezone/json?location=' + center.lat + ',' + center.lon + '&timestamp=' + (dt.getTime() / 1000),
    //         method: 'GET',
    //         success: function(data) {
    //             console.log(data);
    //         }
    //     });
    // }

    function onZipsLayerVisibilityChanged(evt) {
        _settings.layers.zips.visible = _zipsLayer.visibility;
        saveSettings();
        fetchBoundaries();
    }
    function onCountiesLayerVisibilityChanged(evt) {
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
        _$getRoutesButton.css({color: '#00a'});
        let style = {
            strokeColor: '#ff0',
            strokeDashstyle: "solid",
            strokeWidth: 6,
            fillColor: '#ff0',
            fillOpacity: 0.2
        };
        _circleFeature = new OL.Feature.Vector(getCircleLinearRing(), null, style);
        _uspsRoutesMapLayer.addFeatures([ _circleFeature ]);
    }
    function onGetRoutesButtonMouseLeave() {
        _$getRoutesButton.css({color: '#000'});
        _uspsRoutesMapLayer.removeFeatures([ _circleFeature ]);
    }

    function onClearRoutesButtonClick() {
        _uspsRoutesMapLayer.removeAllFeatures();
        _$resultsDiv.empty();
    }

    function showScriptInfoAlert() {
        /* Check version and alert on update */
        if (ALERT_UPDATE && _scriptVersion !== _settings.lastVersion) {
            alert(_scriptVersionChanges);
        }
    }

    var _zipsStyle;
    var _countiesStyle;
    function initLayer(){
        _zipsStyle = {
            strokeColor: '#FF0000',
            strokeOpacity: 1,
            strokeWidth: 3,
            strokeDashstyle: 'solid',
            fillOpacity: 0,
            fontSize: "16px",
            fontFamily: "Arial",
            fontWeight: "bold",
            fontColor: "red",
            label: '${label}',
            labelYOffset: "-20",
            labelOutlineColor: "white",
            labelOutlineWidth: 2
        };
        _countiesStyle = {
            strokeColor: 'pink',
            strokeOpacity: 1,
            strokeWidth: 6,
            strokeDashstyle: 'solid',
            fillOpacity: 0,
            fontSize: "18px",
            fontFamily: "Arial",
            fontWeight: "bold",
            fontColor: "pink",
            label: '${label}',
            labelOutlineColor: "black",
            labelOutlineWidth: 2
        };

        _zipsLayer = new OL.Layer.Vector("US Gov't Boundaries - Zip Codes", {
            uniqueName: "__WMEUSBoundaries_Zips",
            styleMap: new OL.StyleMap({
                default: _zipsStyle
            })
        });
        _countiesLayer = new OL.Layer.Vector("US Gov't Boundaries - Counties", {
            uniqueName: "__WMEUSBoundaries_Counties",
            styleMap: new OL.StyleMap({
                default: _countiesStyle
            })
        });


        _zipsLayer.setOpacity(0.6);
        _countiesLayer.setOpacity(0.6);

        _zipsLayer.setVisibility(_settings.layers.zips.visible);
        _countiesLayer.setVisibility(_settings.layers.counties.visible);

        W.map.addLayers([_countiesLayer, _zipsLayer]);

        _zipsLayer.events.register('visibilitychanged',null,onZipsLayerVisibilityChanged);
        _countiesLayer.events.register('visibilitychanged',null,onCountiesLayerVisibilityChanged);
        W.map.events.register("moveend",W.map,function(e){
            fetchBoundaries();
            // fetchTimeZone();
            return true;
        },true);

        // Add the layer checkbox to the Layers menu.
        WazeWrap.Interface.AddLayerCheckbox("display", "Zip Codes", _settings.layers.zips.visible, onZipsLayerToggleChanged);
        WazeWrap.Interface.AddLayerCheckbox("display", "Counties", _settings.layers.counties.visible, onCountiesLayerToggleChanged);
    }

    function appendTab(name, content) {
        var TAB_SELECTOR = '#user-tabs ul.nav-tabs';
        var CONTENT_SELECTOR = '#user-info div.tab-content';
        var $content;
        var $tab;

        var idName, i = 0;
        if (name && 'string' === typeof name && content && 'string' === typeof content) {
            /* Sanitize name for html id attribute */
            idName = name.toLowerCase().replace(/[^a-z-_]/g, '');
            /* Make sure id will be unique on page */
            while (
                $('#sidepanel-' + (i ? idName + i : idName)).length > 0) {
                i++;
            }
            if (i) {
                idName = idName + i;
            }
            /* Create tab and content */
            $tab = $('<li/>')
                .append($('<a/>')
                        .attr({
                'href': '#sidepanel-' + idName,
                'data-toggle': 'tab'
            })
                        .text(name));
            $content = $('<div/>')
                .addClass('tab-pane')
                .attr('id', 'sidepanel-' + idName)
                .html(content);

            $(TAB_SELECTOR).append($tab);
            $(CONTENT_SELECTOR).first().append($content);
        }
    }

    function initTab() {
        var $content = $('<div>').append(
            $('<fieldset>', {style:'border:1px solid silver;padding:8px;border-radius:4px;'}).append(
                $('<legend>', {style:'margin-bottom:0px;borer-bottom-style:none;width:auto;'}).append(
                    $('<h4>').text('ZIP Codes')
                ),
                $('<div>', {class:'controls-container', style:'padding-top:0px'}).append(
                    $('<input>', {type:'checkbox', id:'usgb-zips-dynamicLabels'}),
                    $('<label>', {for:'usgb-zips-dynamicLabels'}).text('Dynamic label positions')
                )
            ),
            $('<fieldset>', {style:'border:1px solid silver;padding:8px;border-radius:4px;'}).append(
                $('<legend>', {style:'margin-bottom:0px;borer-bottom-style:none;width:auto;'}).append(
                    $('<h4>').text('Counties')
                ),
                $('<div>', {class:'controls-container', style:'padding-top:0px'}).append(
                    $('<input>', {type:'checkbox', id:'usgb-counties-dynamicLabels'}),
                    $('<label>', {for:'usgb-counties-dynamicLabels'}).text('Dynamic label positions')
                ),
                $('<div>', {class:'controls-container', style:'padding-top:0px'}).append(
                    $('<input>', {type:'checkbox', id:'usgb-counties-showState'}),
                    $('<label>', {for:'usgb-counties-showState'}).text('Include state in labels')
                )
            )
        );
        appendTab('USGB', $content.html());

        $('#usgb-zips-dynamicLabels').prop('checked', _settings.layers.zips.dynamicLabels).change(function() {
            _settings.layers.zips.dynamicLabels = $('#usgb-zips-dynamicLabels').is(':checked');
            saveSettings();
            fetchBoundaries();
        });
        $('#usgb-counties-dynamicLabels').prop('checked', _settings.layers.counties.dynamicLabels).change(function() {
            _settings.layers.counties.dynamicLabels = $('#usgb-counties-dynamicLabels').is(':checked');
            saveSettings();
            fetchBoundaries();
        });
        $('#usgb-counties-showState').prop('checked', _settings.layers.counties.showState).change(function() {
            _settings.layers.counties.showState = $('#usgb-counties-showState').is(':checked');
            saveSettings();
            fetchBoundaries();
        });
    }

    function initUspsRoutesLayer(){
        _uspsRoutesMapLayer = new OL.Layer.Vector("USPS Routes", {uniqueName: "__wmeUSPSroutes"});
        W.map.addLayer(_uspsRoutesMapLayer);

        //W.map.setLayerIndex(_uspsRoutesMapLayer, W.map.getLayerIndex(W.map.roadLayers[0])-1);
        // HACK to get around conflict with URO+.  If URO+ is fixed, this can be replaced with the setLayerIndex line above.
        _uspsRoutesMapLayer.setZIndex(334)
        var checkLayerZIndex = () => { if (_uspsRoutesMapLayer.getZIndex() !== 334) _uspsRoutesMapLayer.setZIndex(334); };
        setInterval(function(){checkLayerZIndex();}, 100);
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
        _$resultsDiv = $('<div>', {id: 'usps-route-results', style: 'margin-top:3px;'});
        _$getRoutesButton = $('<button>', {id: 'get-usps-routes', style: 'height:23px;'}).text('Get USPS routes');
        $('#sidebar').prepend(
            $('<div>', {style: 'margin-left:10px;'}).append(
                _$getRoutesButton.click(onGetRoutesButtonClick).mouseenter(onGetRoutesButtonMouseEnter).mouseout(onGetRoutesButtonMouseLeave),
                $('<button>', {id: 'clear-usps-routes', style: 'height:23px; margin-left:4px;'}).text('Clear').click(onClearRoutesButtonClick),
                _$resultsDiv
            )
        );

        log('Initialized.');
    }

    function bootstrap(tries = 1) {
        if (W && W.loginManager && W.loginManager.events && W.loginManager.events.register && W.model && W.model.states && W.model.states.additionalInfo && W.map && W.loginManager.user && WazeWrap.Ready) {
            log('Initializing...');
            init();
        } else {
            if (tries % 20 === 0) log('Bootstrap failed. Trying again...');
            setTimeout(() => bootstrap(++tries), 250);
        }
    }

    log('Bootstrap...');
    bootstrap();
})();
