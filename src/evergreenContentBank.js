// Small, version-controlled, hand-curated fallback catalog for Daily Bank
// categories that are NOT date-sensitive (see dailyContentBank.js's
// EVERGREEN_COMPATIBLE_CATEGORIES). Used only to backfill a category that has
// zero live rows for today -- never to replace live content, and never for
// holiday/on_this_day (those require date-verified web-search accuracy, see
// HANDOFF_2 Phase 5).
//
// Deliberately a small representative seed, not an exhaustive catalog -- the
// goal of Phase 5 is to validate the backfill mechanism end to end; growing
// this list further is a separate, later task.
//
// Each `id` is a fixed, permanent string (never regenerated) so that
// bankItemToCandidate's content_key (`bank_${id}`) stays identical across
// days/runs -- this is what lets Content Memory's anti-repeat cooldown
// (Phase 3) apply to evergreen items exactly like it does to fresh bank rows.
// `tags` are plain arrays (not JSON-encoded strings) -- dailyContentBank.js's
// parseTags() accepts both.
//
// Lives directly under src/ (not src/data/) because this repo's .gitignore
// has an unanchored `data/` rule intended for the runtime SQLite directory
// (./data/app.db) that would otherwise also silently exclude src/data/ from
// version control -- defeating the whole point of a version-controlled
// catalog. Not touching .gitignore keeps this change scoped to Phase 5 only.
module.exports = [
  {
    id: 'evergreen-humor-1',
    category: 'humor',
    content_text: 'Cats spend about 70% of their lives asleep -- a schedule most people only dream of.',
    tags: ['global'],
  },
  {
    id: 'evergreen-humor-2',
    category: 'humor',
    content_text: 'The average person walks past a lost TV remote three times before finally looking under the couch.',
    tags: ['global'],
  },
  {
    id: 'evergreen-idiom-1',
    category: 'idiom',
    content_text: "In Japanese, 'tsundoku' describes buying books and letting them pile up unread.",
    tags: ['global'],
  },
  {
    id: 'evergreen-idiom-2',
    category: 'idiom',
    content_text: "The English idiom 'break the ice' means to ease tension before a conversation starts.",
    tags: ['global'],
  },
  {
    id: 'evergreen-statistic-1',
    category: 'statistic',
    content_text: 'Honey found in ancient tombs is still edible thousands of years later -- it essentially never spoils.',
    tags: ['global'],
  },
  {
    id: 'evergreen-statistic-2',
    category: 'statistic',
    content_text: 'A single bolt of lightning is roughly five times hotter than the surface of the sun.',
    tags: ['global'],
  },
  {
    id: 'evergreen-quote-1',
    category: 'quote',
    content_text: '"The secret of getting ahead is getting started." -- Mark Twain',
    tags: ['global'],
  },
  {
    id: 'evergreen-quote-2',
    category: 'quote',
    content_text: '"Simplicity is the ultimate sophistication." -- Leonardo da Vinci',
    tags: ['global'],
  },
  {
    id: 'evergreen-science-1',
    category: 'science',
    content_text: 'Octopuses have three hearts, and two of them stop beating when the octopus swims.',
    tags: ['global'],
  },
  {
    id: 'evergreen-science-2',
    category: 'science',
    content_text: 'A day on Venus is longer than its year -- it rotates slower than it orbits the sun.',
    tags: ['global'],
  },
  {
    id: 'evergreen-technology-1',
    category: 'technology',
    content_text: 'The first computer mouse, invented in 1964, was carved out of wood.',
    tags: ['global'],
  },
  {
    id: 'evergreen-technology-2',
    category: 'technology',
    content_text: 'The QWERTY keyboard layout was originally designed to slow typists down and prevent jams on mechanical typewriters.',
    tags: ['global'],
  },
  {
    id: 'evergreen-economics-1',
    category: 'economics',
    content_text: 'The word "salary" comes from the Latin for salt, once used to pay Roman soldiers.',
    tags: ['global'],
  },
  {
    id: 'evergreen-economics-2',
    category: 'economics',
    content_text: 'Until 1971, most of the world\'s currencies were directly tied to the value of gold.',
    tags: ['global'],
  },
  {
    id: 'evergreen-fact-1',
    category: 'fact',
    content_text: 'Bananas are botanically classified as berries, but strawberries are not.',
    tags: ['global'],
  },
  {
    id: 'evergreen-fact-2',
    category: 'fact',
    content_text: 'A group of flamingos is called a "flamboyance."',
    tags: ['global'],
  },
];
