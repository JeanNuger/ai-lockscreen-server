// Must stay in sync with BackgroundStylePreset.java on the Android side.
// Replaces the old fixed 6-preset set (CLASSIC_BLUE, DEEP_VIOLET, FOREST_GREEN,
// TERRACOTTA, CHARCOAL, SOFT_SAND) with the 27-preset set from
// lockscreen_presets_spec.json: 9 aurora_mesh (A1-A9), 9 grain_wash (G1-G9),
// 9 origami_facets (O1-O9). The old 6 IDs are intentionally NOT included here
// -- they remain valid/renderable on the Android side for already-saved state
// (enum values not removed), but the server only ever picks from the new 27
// going forward; no backward-compat mapping needed (see TASK_new_background_presets.md
// §4 -- app not yet published under the current listing, so existing saved
// style_id values are test devices only and self-heal on the next batch cycle).
// The server never invents new style_id values; it only picks among these
// when building a batch.
const STYLE_IDS = [
  'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9',
  'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9',
  'O1', 'O2', 'O3', 'O4', 'O5', 'O6', 'O7', 'O8', 'O9',
];

const WINDOWS = ['morning', 'day', 'evening', 'night'];

// How many phrases go out in one batch — matches PRODUCT_REBUILD_PLAN.md §4.1
// ("10-12 фраз + идентификаторы стилей за раз"). Fixed at the top of that
// range (12), not left as a loose 10-12 window, per explicit product decision.
const BATCH_SIZE = 12;

module.exports = { STYLE_IDS, WINDOWS, BATCH_SIZE };
