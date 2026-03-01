# WME US Government Boundaries

Adds interactive boundary overlays to the [Waze Map Editor](https://www.waze.com/editor) for US federal, state, and local administrative areas.

**Authors:** MapOMatic / JS55CT
**License:** GNU GPLv3
**Install:** [GreasyFork](https://greasyfork.org/scripts/25631-wme-us-government-boundaries)
**Forum:** [Waze Community](https://www.waze.com/discuss/t/115019)

---

## What It Shows

| Layer | Data Source | Default Color | Appears At Zoom |
|---|---|---|---|
| States | Census TIGER/Line | Blue `#0000ff` | All zooms (≥ 5) |
| Counties | Census TIGER/Line | Pink `#ffc0cb` | Zoom ≥ 8 (configurable) |
| ZIP Codes | Census TIGER/Line | Red `#ff0000` | Zoom ≥ 12 (configurable) |
| Time Zones | ArcGIS World Time Zones | Orange `#ff8855` | All zooms |
| USPS Routes | USPS EDDM | 6-color palette | On demand |

The map center's current **ZIP code** and **county** are displayed in the WME top bar while the relevant layers are visible.

---

## User Interface

### The USGB Sidebar Tab

Click the **USGB** tab in the WME right sidebar to open the control panel. It contains all settings for the script.

---

### Quick Presets

At the top of the panel, four one-click preset chips instantly restyle all layers at once:

| Preset | What It Does |
|---|---|
| **High Contrast** | Bright primaries (red / yellow / blue / magenta) at 90% opacity |
| **Minimal** | Keeps existing colors but drops every layer to 30% opacity |
| **Colorblind** | Applies the IBM Design colorblind-friendly palette (blue / amber / teal / purple) |
| **Night Mode** | Dark jewel tones (dark red / indigo / navy / brown) at 70% opacity |

> Clicking a preset immediately updates the map and saves the choice to your browser's local storage.

---

### Layer Cards

Each boundary type (States, Counties, ZIP Codes, Time Zones) has its own collapsible card.

#### Visibility Toggle

The **pill-shaped toggle switch** on the right side of every card header turns that layer on or off.

- Toggling here also syncs the corresponding checkbox in the WME **Layer Switcher** panel.
- The setting is saved automatically.

#### Expand / Collapse

Click anywhere on the **card header** (except the toggle) to expand or collapse its settings. An animated chevron indicates the state.

#### Inside an Expanded Card

| Control | How to Use | What It Does |
|---|---|---|
| **Dynamic Label Positions** checkbox | Check / uncheck | When enabled, labels are placed at the visual center of each *visible* polygon section rather than the geographic center. Useful when a boundary is partially off screen. |
| **Boundary Color** swatch | Click the colored box to open the native color picker | Changes the stroke color of the boundary lines and the label text color. |
| **Label Outline** swatch | Click the colored box | Changes the halo/outline color drawn behind label text for legibility. |
| **Opacity** slider | Drag left / right | Controls layer transparency from 0 % (invisible) to 100 % (fully opaque). The current percentage is shown to the right of the slider. |
| **25 % / 50 % / 75 % / 100 %** preset buttons | Click | Snaps the opacity slider to that value instantly. |
| **Minimum Zoom Level** *(Counties & ZIPs only)* | Type a number (1–22) | The layer will only fetch and display data at or above this zoom level. Raising the minimum zoom improves performance when zoomed out. |

> All card settings are saved to `localStorage` immediately on change — no Save button needed.

---

### WME Layer Switcher (Alternative Toggle)

The script registers checkboxes in the standard WME **Layer Switcher** dropdown:

- **USGB – States**
- **USGB – Counties**
- **USGB – Zip codes**
- **USGB – Time zones**

Checking or unchecking these has the same effect as the visibility toggles in the USGB panel — the two controls stay in sync with each other.

---

### USPS Routes Section

Located below the layer cards. Lets you visualize USPS postal delivery routes around the current map center.

| Control | How to Use | What It Does |
|---|---|---|
| **Search Radius (miles)** | Type a value between 0.5 and 2 | Sets how far from the map center to search for routes. |
| **Opacity** slider | Drag left / right | Controls the transparency of the rendered routes. |
| **Get USPS Routes** button | Click | Fetches routes from the USPS EDDM service centered on the current map view. While loading, the button shows a spinner and is disabled. |
| **Get USPS Routes** hover | Hover the mouse over the button (don't click) | A yellow preview circle appears on the map showing exactly what area will be searched. It disappears when the mouse leaves. |
| **Clear** button | Click | Removes all USPS route lines from the map and clears the route legend. |

After a successful fetch, a color-coded **route legend** appears under the buttons. Each entry shows a color swatch and the City/State ZIP label. Clicking a ZIP code label opens the USPS ZIP lookup tool in a new tab.

---

### Status Bar (Map Center Info)

While the **ZIP Codes** and/or **Counties** layers are visible, the script adds a live readout to the WME top bar showing the ZIP code and county that contain the current map center. The ZIP code is a link — clicking it opens the USPS ZIP Code Lookup tool for that ZIP.

---

### Keyboard Shortcuts

The script registers five shortcuts with the WME keyboard shortcut system. By default they are **unassigned** — you assign the actual keys yourself inside WME's keyboard shortcut settings.

| Shortcut ID | Action |
|---|---|
| `usgb-toggle-zips` | Toggle ZIP Codes layer on/off |
| `usgb-toggle-counties` | Toggle Counties layer on/off |
| `usgb-toggle-states` | Toggle States layer on/off |
| `usgb-toggle-timezones` | Toggle Time Zones layer on/off |
| `usgb-fetch-usps-routes` | Trigger a USPS route fetch at the current map center |

To assign a key: open **WME Settings → Keyboard Shortcuts**, find the USGB entries, and click the field to record a key combination.

---

### Reset to Defaults

A **"Reset all to script defaults"** button at the bottom of the USGB panel restores every setting (colors, opacity, zoom thresholds, visibility) to the original script values. A confirmation dialog appears before any changes are made.

---

## Settings Persistence

All preferences are stored in `localStorage` under the key `wme_us_government_boundaries`. Settings survive page refreshes and browser restarts. Keyboard shortcut bindings are saved when you leave the WME page (`beforeunload`).

---

## Performance Notes

- **Boundary data** is fetched only when the map stops moving (250 ms debounce). Rapid panning does not trigger multiple simultaneous requests.
- **ZIP Codes** and **Counties** have configurable minimum zoom levels to avoid fetching large amounts of data when zoomed out.
- **Labels** are suppressed for boundary sections smaller than 0.5 % of the visible screen area, reducing visual clutter at all zoom levels.
