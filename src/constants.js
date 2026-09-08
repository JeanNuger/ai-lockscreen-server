// Must stay in sync with BackgroundStylePreset.java on the Android side (6 fixed
// presets — see PRODUCT_REBUILD_PLAN.md §3 "В MVP входит: фон карточки — фиксированный
// набор из 6 стилей"). The server never invents new style_id values; it only picks
// among these when building a batch.
const STYLE_IDS = [
  'CLASSIC_BLUE',
  'DEEP_VIOLET',
  'FOREST_GREEN',
  'TERRACOTTA',
  'CHARCOAL',
  'SOFT_SAND',
];

const WINDOWS = ['morning', 'day', 'evening', 'night'];

// How many phrases go out in one batch — matches PRODUCT_REBUILD_PLAN.md §4.1
// ("10-12 фраз + идентификаторы стилей за раз").
const BATCH_SIZE = 10;

module.exports = { STYLE_IDS, WINDOWS, BATCH_SIZE };
