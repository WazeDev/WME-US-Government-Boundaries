// ==UserScript==
// @name         WME US Government Boundaries (beta)
// @namespace    https://greasyfork.org/users/45389
// @version      0.5.0
// @description  Adds a layer to display US (federal, state, and/or local) boundaries.
// @author       MapOMatic
// @include      /^https:\/\/(www|beta)\.waze\.com\/(?!user\/)(.{2,6}\/)?editor\/?.*$/
// @require      https://greasyfork.org/scripts/24851-wazewrap/code/WazeWrap.js?version=203355
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

    var SETTINGS_STORE_NAME = 'wme_us_government_boundaries';
    var DEBUG_LEVEL = 0;
    var ALERT_UPDATE = false;
    var ZIPS_LAYER_URL = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/PUMA_TAD_TAZ_UGA_ZCTA/MapServer/4/';
    var COUNTIES_LAYER_URL = 'https://tigerweb.geo.census.gov/arcgis/rest/services/Census2010/State_County/MapServer/1/';

    var _scriptVersion = GM_info.script.version;
    var _scriptVersionChanges = [
        GM_info.script.name + '\nv' + _scriptVersion + '\n\nWhat\'s New\n------------------------------\n',
        '\n- Restored zip->city lookup.'
    ].join('');
    var _zipsLayer;
    var _countiesLayer;
    var _settings = {};

    function getStateNameFromAbbr(stateAbbr) {
        for (var stateName in _statesHash) {
            if (_statesHash[stateName] == stateAbbr) return stateName;
        }
    }

    function log(message, level) {
        if (message && (!level || (level <= DEBUG_LEVEL))) {
            console.log('US Boundaries: ', message);
        }
    }

    function loadSettings() {
        var loadedSettings = $.parseJSON(localStorage.getItem(SETTINGS_STORE_NAME));
        var defaultSettings = {
            lastVersion:null,
            layerOpacity: 0.6,
            zipsVisible:true,
            zipsColor:'#F00',
            zipsWidth:3,
            countiesVisible:true,
            countiesColor:'A00',
            countiesWidth: 3
        };
        _settings = loadedSettings ? loadedSettings : defaultSettings;
        for (var prop in defaultSettings) {
            if (!_settings.hasOwnProperty(prop)) {
                _settings[prop] = defaultSettings[prop];
            }
        }
    }

    function saveSettings() {
        if (localStorage) {
            _settings.lastVersion = _scriptVersion;
            _settings.zipsVisible = _zipsLayer.visibility;
            _settings.countiesVisible = _countiesLayer.visibility;
            localStorage.setItem(SETTINGS_STORE_NAME, JSON.stringify(_settings));
            log('Settings saved', 1);
        }
    }

    function getUrl(baseUrl, extent, zoom, outFields) {
        var whereParts = [];
        var geometry = { xmin:extent.left, ymin:extent.bottom, xmax:extent.right, ymax:extent.top, spatialReference: {wkid: 102100, latestWkid: 3857} };
        var geometryStr = JSON.stringify(geometry);
        var offsets = [40,20,10,4,2,1,0.5,0.25,0.125,0.0625,0.03125];
        var url = baseUrl + 'query?geometry=' + encodeURIComponent(geometryStr);
        url += '&returnGeometry=true';
        //url += '&maxAllowableOffset=' + offsets[zoom];
        url += '&outFields=' + encodeURIComponent(outFields.join(','));
        url += '&quantizationParameters={tolerance:100}';
        url += '&spatialRel=esriSpatialRelIntersects&geometryType=esriGeometryEnvelope&inSR=102100&outSR=3857&f=json';
        return url;
    }

    function appendCityToZip(html, context) {
        if (!context.cancel) {
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

    function updateNameDisplay(context){
        var mapCenter = new OpenLayers.Geometry.Point(W.map.center.lon,W.map.center.lat);
        var feature;
        var color;
        var text = '';
        var label;
        var url;
        var $div, $span;
        var i;
        if (_zipsLayer && _zipsLayer.visibility) {
            for (i=0;i<_zipsLayer.features.length;i++){
                feature = _zipsLayer.features[i];
                if(feature.geometry.containsPoint(mapCenter)) {
                    label = feature.attributes.label;
                    text = 'ZIP: ' + label;
                    //color = _colorLookup['IN-' + feature.attributes.name].fillColor;
                    $('<span>', {id:'zip-text'}).css({display:'inline-block'})
                        .append(
                        $('<a>', {href:url, target:'__blank', title:'Look up USPS zip code'})
                        .text(text)
                        .css({color:'white',display:'inline-block'})
                    )
                        .appendTo($('#zip-boundary'));
                    GM_xmlhttpRequest({
                        url: 'https://wazex.us/zips/ziptocity.php?zip=' + label,
                        context: context,
                        method: 'GET',
                        onload: function(res) {appendCityToZip(res.responseText, res.context);}
                    });
                }
            }
        }
        if (_countiesLayer && _countiesLayer.visibility) {
            for (i=0;i<_countiesLayer.features.length;i++){
                feature = _countiesLayer.features[i];
                if(feature.geometry.containsPoint(mapCenter)) {
                    label = feature.attributes.label;
                    var match = label.match(/ County$/);
                    if (match) {
                        label = label.substr(0, match.index);
                    }
                    $('<span>', {id:'county-text'}).css({display:'inline-block'})
                        .text('County: ' + label)
                        .appendTo($('#county-boundary'));
                }
            }
        }
    }

    function processBoundaries(boundaries, context, type, nameField, labelField) {
        var layer;

        if (context.cancel ||
            !_settings.zipsVisible && type === 'zip' ||
            !_settings.countiesVisible && type === 'county') {
            // do nothing
        } else {
            if (type==='zip') {
                layer = _zipsLayer;
            } else if (type==='county') {
                layer = _countiesLayer;
            }
            layer.removeAllFeatures();
            if (!context.cancel) {
                boundaries.forEach(function(boundary) {
                    var attributes = {
                        name: boundary.attributes[nameField],
                        type: type
                    };
                    if (labelField) attributes.label = boundary.attributes[labelField];

                    var rings = [];
                    boundary.geometry.rings.forEach(function(ringIn) {
                        var pnts= [];
                        for(var i=0;i<ringIn.length;i++){
                            pnts.push(new OpenLayers.Geometry.Point(ringIn[i][0], ringIn[i][1]));
                        }
                        rings.push(new OpenLayers.Geometry.LinearRing(pnts));
                    });
                    var polygon = new OpenLayers.Geometry.Polygon(rings);
                    var feature = new OpenLayers.Feature.Vector(polygon,attributes);

                    if (!context.cancel) {
                        layer.addFeatures([feature]);
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

    var _processContexts = [];

    function fetchBoundaries() {
        if (_processContexts.length > 0) {
            _processContexts.forEach(function(context) {context.cancel = true;});
        }

        var extent = Waze.map.getExtent();
        var zoom = Waze.map.getZoom();
        var url;
        var context = {callCount:0, cancel:false};
        _processContexts.push(context);
        $('.us-boundary-region').remove();
        $('.loading-indicator-region').before(
            $('<div>', {id:'county-boundary', class:"us-boundary-region"}).css({color:'white', float:'left', marginLeft:'10px'}),
            $('<div>', {id:'zip-boundary', class:"us-boundary-region"}).css({color:'white', float:'left', marginLeft:'10px'})
        );
        if (_settings.zipsVisible) {
            url = getUrl(ZIPS_LAYER_URL, extent, zoom, ['ZCTA5']);
            context.callCount++;
            $.ajax({
                url: url,
                context: context,
                method: 'GET',
                datatype: 'json',
                success: function(data) {processBoundaries($.parseJSON(data).features, this, 'zip', 'ZCTA5', 'ZCTA5'); }
            });
        }
        if (_settings.countiesVisible) {
            url = getUrl(COUNTIES_LAYER_URL, extent, zoom, ['NAME']);
            context.callCount++;
            $.ajax({
                url: url,
                context: context,
                method: 'GET',
                datatype: 'json',
                success: function(data) {processBoundaries($.parseJSON(data).features, this, 'county', 'NAME', 'NAME'); }
            });
        }
    }

    function onZipsLayerVisibilityChanged(evt) {
        _settings.zipsVisible = _zipsLayer.visibility;
        saveSettings();
        fetchBoundaries();
    }
    function onCountiesLayerVisibilityChanged(evt) {
        _settings.countiesVisible = _countiesLayer.visibility;
        saveSettings();
        fetchBoundaries();
    }

    function onModeChanged(model, modeId, context) {
        if(!modeId || modeId === 1) {
            initUserPanel();
        }
    }

    function onZipsLayerToggleChanged(checked) {
        _zipsLayer.setVisibility(checked);
    }
    function onCountiesLayerToggleChanged(checked) {
        _countiesLayer.setVisibility(checked);
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
            label : "${label}",
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
        _countiesStyle = {
            strokeColor: 'pink',
            strokeOpacity: 1,
            strokeWidth: 6,
            strokeDashstyle: 'solid',
            fillOpacity: 0,
            //label : "${label}",
            //fontSize: "16px",
            //fontFamily: "Courier New, monospace",
            //fontWeight: "bold",
            //fontColor: "orange",
            //labelAlign: "${align}",
            //labelXOffset: "${xOffset}",
            //labelYOffset: "${yOffset}",
            labelOutlineColor: "black",
            labelOutlineWidth: 1
        };

        _zipsLayer = new OpenLayers.Layer.Vector("US Gov't Boundaries - Zip Codes", {
            uniqueName: "__WMEUSBoundaries_Zips",
            displayInLayerSwitcher: true,
            styleMap: new OpenLayers.StyleMap({
                default: _zipsStyle,
            })
        });
        _countiesLayer = new OpenLayers.Layer.Vector("US Gov't Boundaries - Counties", {
            uniqueName: "__WMEUSBoundaries_Counties",
            displayInLayerSwitcher: true,
            styleMap: new OpenLayers.StyleMap({
                default: _countiesStyle,
            })
        });


        _zipsLayer.setOpacity(0.6);
        _countiesLayer.setOpacity(0.6);

        _zipsLayer.setVisibility(_settings.zipsVisible);
        _countiesLayer.setVisibility(_settings.countiesVisible);

        Waze.map.addLayers([_countiesLayer, _zipsLayer]);

        _zipsLayer.events.register('visibilitychanged',null,onZipsLayerVisibilityChanged);
        _countiesLayer.events.register('visibilitychanged',null,onCountiesLayerVisibilityChanged);
        Waze.map.events.register("moveend",Waze.map,function(e){
            fetchBoundaries();
            return true;
        },true);

        // Add the layer checkbox to the Layers menu.
        AddLayerCheckbox("display", "Zip Codes", _settings.zipsVisible, onZipsLayerToggleChanged);
        AddLayerCheckbox("display", "Counties", _settings.countiesVisible, onCountiesLayerToggleChanged);
    }

    function appendTab(name, content) {
        var TAB_SELECTOR = '#user-tabs ul.nav-tabs';
        var CONTENT_SELECTOR = '#user-info div.tab-content';
        var $content;
        var $tab;

        var idName, i = 0;
        if (name && 'string' === typeof name &&  content && 'string' === typeof content) {
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
                'data-toggle': 'tab',
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
            $('<div>').text('Under construction...')
            // $('<div>').append(
            //     $('<input>', {type:'checkbox', id:'usgb-show-zips'}),
            //     $('<label>', {for:'usgb-show-zips'}).text('Zip codes')
            // ),
            // $('<div>').append(
            //     $('<input>', {type:'checkbox', id:'usgb-show-counties'}),
            //     $('<label>', {for:'usgb-show-counties'}).text('Counties')
            // )
        );
        appendTab('USGB', $content.html());

        // $('#usgb-show-zips').prop('checked', _settings.zipsVisible).change(function() {
        //     _settings.zipsVisible = $('#usgb-show-zips').is(':checked');
        //     saveSettings();
        //     if (_settings.zipsVisible) {
        //         fetchBoundaries();
        //     } else {
        //         _zipsLayer.removeAllFeatures();
        //     }
        // });
        // $('#usgb-show-counties').prop('checked', _settings.countiesVisible).change(function() {
        //     _settings.countiesVisible = $('#usgb-show-counties').is(':checked');
        //     saveSettings();
        //     if (_settings.countiesVisible) {
        //         fetchBoundaries();
        //     } else {
        //         _countiesLayer.removeAllFeatures();
        //     }
        // });
    }

    function init() {
        loadSettings();
        String.prototype.replaceAll = function(search, replacement) {
            var target = this;
            return target.replace(new RegExp(search, 'g'), replacement);
        };
        initLayer();
        initTab();
        showScriptInfoAlert();
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

    // "Borrowed" from WazeWrap until it works with sandboxed scripts:
    function AddLayerCheckbox(group, checkboxText, checked, callback) {
        group = group.toLowerCase();
        var normalizedText = checkboxText.toLowerCase().replace(/\s/g, '_');
        var checkboxID = "layer-switcher-item_" + normalizedText;
        var groupPrefix = 'layer-switcher-group_';
        var groupClass = groupPrefix + group.toLowerCase();
        sessionStorage[normalizedText] = checked;

        var CreateParentGroup = function(groupChecked){
            var groupList = $('.layer-switcher').find('.list-unstyled.togglers');
            var checkboxText = group.charAt(0).toUpperCase() + group.substr(1);
            var newLI = $('<li class="group">');
            newLI.html([
                '<div class="controls-container toggler">',
                '<input class="' + groupClass + '" id="' + groupClass + '" type="checkbox" ' + (groupChecked ? 'checked' : '') +'>',
                '<label for="' + groupClass + '">',
                '<span class="label-text">'+ checkboxText + '</span>',
                '</label></div>',
                '<ul class="children"></ul>'
            ].join(' '));

            groupList.append(newLI);
            $('#' + groupClass).change(function(){sessionStorage[groupClass] = this.checked;});
        };

        if(group !== "issues" && group !== "places" && group !== "road" && group !== "display") //"non-standard" group, check its existence
            if($('.'+groupClass).length === 0){ //Group doesn't exist yet, create it
                var isParentChecked = (typeof sessionStorage[groupClass] == "undefined" ? true : sessionStorage[groupClass]=='true');
                CreateParentGroup(isParentChecked);  //create the group
                sessionStorage[groupClass] = isParentChecked;

                Waze.app.modeController.model.bind('change:mode', function(model, modeId, context){ //make it reappear after changing modes
                    CreateParentGroup((sessionStorage[groupClass]=='true'));
                });
            }

        var buildLayerItem = function(isChecked){
            var groupChildren = $("."+groupClass).parent().parent().find('.children').not('.extended');
            var $li = $('<li>');
            $li.html([
                '<div class="controls-container toggler">',
                '<input type="checkbox" id="' + checkboxID + '"  class="' + checkboxID + ' toggle">',
                '<label for="' + checkboxID + '"><span class="label-text">' + checkboxText + '</span></label>',
                '</div>',
            ].join(' '));

            groupChildren.append($li);
            $('#' + checkboxID).prop('checked', isChecked);
            $('#' + checkboxID).change(function(){callback(this.checked); sessionStorage[normalizedText] = this.checked;});
            if(!$('#' + groupClass).is(':checked')){
                $('#' + checkboxID).prop('disabled', true);
                callback(false);
            }

            $('#' + groupClass).change(function(){$('#' + checkboxID).prop('disabled', !this.checked); callback(this.checked);});
        };


        Waze.app.modeController.model.bind('change:mode', function(model, modeId, context){
            buildLayerItem((sessionStorage[normalizedText]=='true'));
        });

        buildLayerItem(checked);
    }




})();
