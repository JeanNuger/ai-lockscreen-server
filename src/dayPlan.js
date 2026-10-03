const { STYLE_IDS: ALL_STYLE_IDS } = require('./constants');
// The app ships only the Aurora (A) and Grain wash (G) backgrounds: a style_id of a removed family (O) is
// unknown to the phone and would turn the phrase into a background-only frame.
// A9 (smoky) and G4 (graphite) are retired too (task 26): 16 backgrounds, enough for 12 different ones in a window.
const RETIRED_STYLE_IDS = new Set(['A9', 'G4']);
const STYLE_IDS = ALL_STYLE_IDS.filter((id) => /^[AG]\d$/.test(id) && !RETIRED_STYLE_IDS.has(id));
const { validateLockScreenText } = require('./textFilter');
const { loadSentArchive, findRepeat, recordSentContent, loadShownFacts, isFactShown } = require('./sentPhrases');
const { loadSeenPhrases, loadLearnedWords, deviceReportsShown } = require('./seenMemory');
const { _test: planner } = require('./slotPlanner');
const { _test: generator } = require('./contentGenerator');
const db = require('./db');
const rotation = require('./dayRotation');
const { cityTag } = require('./dailyContentBank');

// The whole day in ONE model call (GET /api/v1/day): 4 windows x 12 phrases in the fixed order of
// PRODUCT_REBUILD_PLAN.md section 4, written as one monologue. Facts come only from the daily bank
// (src/dailyContentBank.js); jokes, thoughts, wishes, horoscope, tips and ideas are the model's own.
//
// Model: gpt-6-luna with reasoning "none" (tests 23-24). Both are env-overridable.

const MAX_LEN = 70;
const DEFAULT_MAX_CHARS = 60;
const WINDOW_ORDER = ['morning', 'day', 'evening', 'night'];
const DAY_MODEL_DEFAULT = 'gpt-6-luna';
const DAY_EFFORT_DEFAULT = 'none';
const DAY_TIMEOUT_MS = 75000;
const DAY_MAX_ATTEMPTS = 2;
const REPAIR_TIMEOUT_MS = 30000;
const DAY_MAX_COMPLETION_TOKENS = 20000;
// Pairs that always go together: if one half is missing the other is dropped (quiz question +
// answer; word of the day, see WORD_SLOTS).
const QUIZ_PAIRS = [['d4', 'd5'], ['e9', 'e10'], ['n4', 'n5']];
const WORD_SLOTS = { teach: 'm7', recall: 'n8', answer: 'n9' };
// Teach -> recall -> answer trios: the word of the day (morning 7, night 8 + 9) and the foreign word
// (morning 10, evening 2 + 3). A recall and its answer stand or fall together and need the taught phrase.
const FOREIGN_SLOTS = { teach: 'm10', recall: 'e2', answer: 'e3' };
const WORD_TRIOS = [WORD_SLOTS, FOREIGN_SLOTS];
const REPAIR_EXEMPT = new Set(['greeting_name', 'goodnight_care']);
// A quiz question holds the question and 2-3 options, the answer a full phrase with its explanation: up to MAX_LEN.
// A phrase still too long after the first repair call gets one more (see generateDay).
const MAX_REPAIR_ROUNDS = 2;
const QUIZ_MAX_CHARS = 60; // the limit is 70 (MAX_LEN); the model aims lower, it miscounts the options
// Beginner words that are no "useful intermediate word" (task 28): never taught as the foreign word, in any
// of the ten languages. Compared lower-cased and trimmed.
const BASIC_FOREIGN_WORDS = new Set([
  'hello', 'hi', 'hey', 'bye', 'goodbye', 'yes', 'no', 'please', 'thanks', 'thank you', 'sorry', 'cat', 'dog', 'apple', 'water',
  'house', 'book', 'friend', 'good', 'bad', 'red', 'blue', 'green', 'one', 'two', 'three', 'mother', 'father', 'love',
  'bonjour', 'salut', 'merci', 'chat', 'chien', 'pomme', 'eau', 'maison', 'livre', 'ami', 'au revoir', 's\'il vous plait',
  'hola', 'gracias', 'adios', 'adiós', 'gato', 'perro', 'manzana', 'agua', 'casa', 'libro', 'amigo', 'por favor',
  'olá', 'ola', 'obrigado', 'obrigada', 'tchau', 'gato', 'cachorro', 'maçã', 'água', 'casa', 'livro', 'amigo',
  'hallo', 'danke', 'tschüss', 'tschuss', 'katze', 'hund', 'apfel', 'wasser', 'haus', 'buch', 'freund', 'bitte',
  'ciao', 'grazie', 'arrivederci', 'gatto', 'cane', 'mela', 'acqua', 'casa', 'libro', 'amico', 'prego', 'per favore',
  'привет', 'пока', 'спасибо', 'да', 'нет', 'кот', 'собака', 'яблоко', 'вода', 'дом', 'книга', 'друг', 'пожалуйста',
  'こんにちは', 'ありがとう', 'さようなら', '猫', '犬', '水', '本', '안녕하세요', '안녕', '감사합니다', '고양이', '개', '물', '책',
  '你好', '谢谢', '再见', '猫', '狗', '水', '书', '朋友',
]);

const QUIZ_Q = 'A quiz question in the user\'s language with 2-3 answer options inside the phrase, at most 60 characters: "Which frog survives winter frozen: tree frog, pond frog or toad?". Built on the fact in "bank_item" (only that fact); the answer comes in the next slot.';
const QUIZ_A = 'The answer to the previous slot as a full phrase with a short explanation, at most 60 characters: "Answer: tree frog - in spring it thaws and hops on" (in the user\'s language).';

const S = (window, position, type, topic, extra = {}) => ({
  window, position, type, topic, max_chars: DEFAULT_MAX_CHARS, ...extra,
});

// The 48 slots (task 27, day scheme v2). The type of every position is fixed; on Saturday and Sunday
// day 3 and day 12 become the events poster (buildDaySlots).
//  - word of the day: morning 7 teaches the word and its meaning; night 8 asks "do you remember what
//    "..." means?"; night 9 answers "Right: ... is ..." (night 8 + 9 always together).
//  - foreign language: morning 10 teaches a word of the learning language with its translation; evening 2
//    asks "do you remember how to say ...?", evening 3 answers "Right: ..." (evening 2 + 3 need morning 10).
//  - interest of the day (night 2): the device's next interest of its circle, one fact of the bank.
//  - holiday (morning 4): local, else international, else an interesting fact (see buildDaySlots).
//  - phone data: only morning 8, about yesterday (dropped when the phone sent nothing).
function slotDefinitions() {
  return [
    S('morning', 1, 'greeting_name', 'Warm good-morning greeting with the name.'),
    S('morning', 2, 'weather_advice', 'What to wear or take TODAY, from the weather block ("today rain - take an umbrella"). Advice only, no numbers.'),
    S('morning', 3, 'horoscope', 'Light, kind note for the zodiac sign. No health/money/fate predictions.'),
    S('morning', 4, 'holiday', 'Holiday today, from the item given in "bank_item" (use exactly that item).'),
    S('morning', 5, 'on_this_day', '"On this day in <year> ..." from bank category on_this_day.', { bank: 'on_this_day' }),
    S('morning', 6, 'numerology', 'Name the personal day number and its light meaning today.'),
    S('morning', 7, 'word_of_day', 'Teach a modern, useful word of the user\'s language that widens an adult\'s vocabulary, with its meaning, in one phrase: a word people really use today in speech, press and books, not archaic, obsolete, dialect or slang (your own choice, not in already_seen / learned_words). Also return it in "word_of_day".'),
    S('morning', 8, 'phone_yesterday', 'ONE recap of yesterday from the phone block, e.g. "yesterday you walked a lot - repeat it?". No numbers, friendly, not judging; do not say "data".'),
    S('morning', 9, 'quote', 'A short quote with its author, from bank category quote.', { bank: 'quote' }),
    S('morning', 10, 'foreign_word', 'Teach one useful word of the learning language (see "learning_language") with its translation into the user\'s language, e.g. "<word> - <translation>": an intermediate (B1-B2) word an adult needs in real life, never a beginner word (no hello, thanks, cat, water, numbers, colours) (your own choice, not in learned_foreign_words). Also return the bare foreign word in "foreign_word".'),
    S('morning', 11, 'lifehack', 'One concrete, slightly surprising, doable trick.'),
    S('morning', 12, 'warm_wish', 'One sincere, specific wish for the day ahead.'),

    S('day', 1, 'humor', 'Your own light, clever everyday joke.'),
    S('day', 2, 'science_fact', 'Bank category science.', { bank: 'science' }),
    S('day', 3, 'country_fact', 'A fact about the user\'s country (profile country), bank category country_fact.', { bank: 'country_fact' }),
    S('day', 4, 'quiz_question', QUIZ_Q, { max_chars: QUIZ_MAX_CHARS, quiz: ['animals', 'nature'] }),
    S('day', 5, 'quiz_answer', QUIZ_A, { max_chars: QUIZ_MAX_CHARS, ref: 'd4' }),
    S('day', 6, 'number_of_day', 'One surprising number with what it means; from the fact in "bank_item" (it contains a number).', { number: true }),
    S('day', 7, 'word_origin', 'Where a word came from, bank category word_origin.', { bank: 'word_origin' }),
    S('day', 8, 'animal_fact', 'Bank category animals.', { bank: 'animals' }),
    S('day', 9, 'tech_fact', 'Bank category tech.', { bank: 'tech' }),
    S('day', 10, 'money_simple', 'Money in simple words, bank category money.', { bank: 'money' }),
    S('day', 11, 'brain_psychology', 'Bank category brain.', { bank: 'brain' }),
    S('day', 12, 'thought', 'A thought of your own, fresh angle, not a poster slogan.'),

    S('evening', 1, 'good_news', 'Bank category good_news.', { bank: 'good_news' }),
    S('evening', 2, 'foreign_recall', 'Ask, do not answer: "Do you remember how to say «<the translation of morning slot 10>» in <the learning language>?" in the user\'s language.', { ref: 'm10' }),
    S('evening', 3, 'foreign_answer', 'The answer to evening slot 2: "Right: <the foreign word of morning slot 10>" in the user\'s language.', { ref: 'm10' }),
    S('evening', 4, 'gender_tip', 'A tip that is really about being a man (profile gender male) or a woman (female): a concrete thing about men\'s or women\'s health, body, style, relationships or typical situations. Not a general lifehack, not a repeat of the morning lifehack (morning slot 11). No stereotypes, no lecturing.', { ref: 'm11' }),
    S('evening', 5, 'space_fact', 'Bank category space.', { bank: 'space' }),
    S('evening', 6, 'born_today', 'Start "On this day was born ..." (in the user\'s language) - one person from bank category born_today. Never "today was born".', { bank: 'born_today' }),
    S('evening', 7, 'city_fact', 'A fact about the user\'s city (profile city), bank category city_fact.', { bank: 'city_fact' }),
    S('evening', 8, 'dinner_idea', 'A dinner idea that takes 15 minutes. Concrete dish.'),
    S('evening', 9, 'quiz_question', QUIZ_Q, { max_chars: QUIZ_MAX_CHARS, quiz: ['tech', 'space', 'how_it_works'] }),
    S('evening', 10, 'quiz_answer', QUIZ_A, { max_chars: QUIZ_MAX_CHARS, ref: 'e9' }),
    S('evening', 11, 'how_it_works', 'How something familiar works, bank category how_it_works.', { bank: 'how_it_works' }),
    S('evening', 12, 'evening_idea', 'An idea of how to spend the evening.'),

    S('night', 1, 'humor', 'A calm joke of your own that plays on the evening idea (evening slot 12).', { ref: 'e12' }),
    S('night', 2, 'interest_fact', 'The fact of the day for the user\'s interest, from the item given in "bank_item" (use exactly that item).'),
    S('night', 3, 'watch_or_read', 'What to watch or read: the film, series or book of bank category watch_read, with a few words on why.', { bank: 'watch_read' }),
    S('night', 4, 'quiz_question', QUIZ_Q, { max_chars: QUIZ_MAX_CHARS, quiz: ['unusual', 'tradition', 'word_origin'] }),
    S('night', 5, 'quiz_answer', QUIZ_A, { max_chars: QUIZ_MAX_CHARS, ref: 'n4' }),
    S('night', 6, 'tradition', 'An unusual tradition of another country, bank category tradition.', { bank: 'tradition' }),
    S('night', 7, 'poetic_thought', 'A quiet poetic image, gentle, not pompous.'),
    S('night', 8, 'word_recall', 'Ask, do not answer: "Do you remember what “<the word of morning slot 7>” means?" in the user\'s language.', { ref: 'm7' }),
    S('night', 9, 'word_answer', 'The answer to night slot 8: "Right: <word> is <meaning>" in the user\'s language.', { ref: 'm7' }),
    S('night', 10, 'nature_fact', 'Bank category nature.', { bank: 'nature' }),
    S('night', 11, 'tomorrow_task', 'One small doable thing for tomorrow (here "tomorrow" is allowed).'),
    S('night', 12, 'goodnight_care', '"Good night" with the name; may return to the morning wish (morning slot 12).', { ref: 'm12' }),
  ].map((slot, index) => ({
    slot_id: `${slot.window[0]}${slot.position}`,
    order: index + 1,
    ...slot,
  }));
}

// Local holiday (item tagged with the user's country) -> international day ("global") -> null.
// Items are daily_content_bank rows {id, category, content_text, tags}.
function pickHoliday(bankRows, countryCode) {
  const holidays = (bankRows || []).filter((row) => row.category === 'holiday');
  const country = typeof countryCode === 'string' ? countryCode.toUpperCase() : null;
  const tagsOf = (row) => (Array.isArray(row.tags) ? row.tags : parseTagsLoose(row.tags));
  const local = country ? holidays.filter((row) => tagsOf(row).includes(country)) : [];
  if (local.length > 0) {
    return { row: local[0], kind: 'local' };
  }
  const international = holidays.filter((row) => tagsOf(row).includes('global'));
  if (international.length > 0) {
    return { row: international[0], kind: 'international' };
  }
  return null;
}

function tagsOfRow(row) {
  return Array.isArray(row.tags) ? row.tags : parseTagsLoose(row.tags);
}

function parseTagsLoose(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

// ---- one fact, one phrase (task 28) ----

// Categories the "number of the day" may take its fact from (a fact with a digit in it): never the date-bound,
// poster, film, news or interest rows.
const NUMBER_CATEGORIES = new Set(['science', 'animals', 'space', 'nature', 'tech', 'unusual', 'money', 'brain',
  'tradition', 'how_it_works', 'word_origin', 'country_fact', 'city_fact']);

function bankItemOf(row) {
  return { id: `b${row.id}`, text: row.content_text, category: row.category, subject: row.subject || '' };
}

// The server, not the model, chooses the bank fact of every slot that needs one: strictly from the category of
// the slot (good news only good_news, poster only afisha, a quiz from its own categories, the number of the
// day from a fact with a digit - never an interest_* row, those only feed the interest slot), every fact in
// at most one slot, and no two facts of one subject in a day. A quiz question and its answer share their fact.
// A slot that finds nothing is dropped (nothing is invented); the answer goes with its question.
function assignBankItems(slots, rows) {
  const used = new Set(slots.filter((slot) => slot.bank_item).map((slot) => slot.bank_item.id));
  const usedSubjects = new Set(slots.filter((slot) => slot.bank_item && slot.bank_item.subject)
    .map((slot) => String(slot.bank_item.subject).trim().toLowerCase()));
  const take = (accept) => {
    const row = rows.find((candidate) => {
      const id = `b${candidate.id}`;
      const subject = String(candidate.subject || '').trim().toLowerCase();
      return !used.has(id) && accept(candidate) && !(subject && usedSubjects.has(subject));
    });
    if (!row) return null;
    used.add(`b${row.id}`);
    if (row.subject) usedSubjects.add(String(row.subject).trim().toLowerCase());
    return bankItemOf(row);
  };
  const dropped = new Set();
  const pick = (slot, accept) => {
    const item = take(accept);
    if (item) slot.bank_item = item;
    else dropped.add(slot.slot_id);
  };
  // 1. slots with a category of their own, in the order of the day
  for (const slot of slots) {
    if (slot.bank && slot.bank !== 'any' && !slot.bank_item) {
      pick(slot, (row) => row.category === slot.bank);
    }
  }
  // 2. quiz questions take what is left of their categories
  for (const slot of slots) {
    if (slot.quiz) {
      let item = null;
      for (const category of slot.quiz) {
        item = take((row) => row.category === category);
        if (item) break;
      }
      if (item) slot.bank_item = item;
      else dropped.add(slot.slot_id);
    }
  }
  // 3. the number of the day: a fact with a digit that nobody else uses
  for (const slot of slots) {
    if (slot.number) {
      pick(slot, (row) => NUMBER_CATEGORIES.has(row.category) && /\d/.test(row.content_text));
    }
  }
  // 4. an answer shares the fact of its question (and goes when the question goes)
  for (const slot of slots) {
    if (slot.type === 'quiz_answer') {
      const question = slots.find((other) => other.slot_id === slot.ref);
      if (question && question.bank_item && !dropped.has(question.slot_id)) slot.bank_item = question.bank_item;
      else dropped.add(slot.slot_id);
    }
  }
  return slots.filter((slot) => !dropped.has(slot.slot_id));
}

// The slots of one device's day. Drops slots that have nothing to stand on: the weather advice
// without a forecast, the phone recap without phone data. The holiday slot takes the local holiday,
// else the international day, else becomes an interesting fact from the bank (type unusual_fact,
// holiday_replaced = true), so a "no holiday today" phrase can never be written.
//
// Task 27 additions (all optional, the defaults keep the plain 48):
//  - weekend + afishaCount: on Saturday and Sunday day 3 (needs 1+ events) and day 12 (needs 2+) become the
//    events poster; with no events they keep the weekday topic.
//  - hasCountryFacts / hasCityFacts / hasWatchRead: false drops the slot that has no bank fact for this user.
//  - interest: { key, row } fills night 2 with that interest's fact, null drops it.
//  - learningLanguage: { code, name } names the language of morning 10 and evening 2-3.
// Task 28 additions:
//  - rows: the bank rows this user may be offered (see bankRowsForUser); when given, every slot that needs a fact
//    gets its own "bank_item" (assignBankItems) and is dropped when there is none. Without rows nothing is assigned.
//  - gender: the profile gender; the tip for men or women (evening 4) needs "male" or "female", else it is dropped.
function buildDaySlots({
  holiday, hasWeather, hasPhone, weekend = false, afishaCount = 0,
  hasCountryFacts = true, hasCityFacts = true, hasWatchRead = true, interest, learningLanguage, rows, gender,
}) {
  const slots = [];
  let holidayReplaced = false;
  for (const def of slotDefinitions()) {
    if (def.type === 'weather_advice' && !hasWeather) continue;
    if (def.type === 'phone_yesterday' && !hasPhone) continue;
    if (weekend && def.slot_id === 'd3' && afishaCount >= 1) {
      slots.push({
        ...def,
        type: 'afisha',
        topic: 'Weekend poster: ONE real event from bank category afisha that suits the user\'s age (profile age) and happens today; say what, where and when. Never invent an event.',
        bank: 'afisha',
        afisha: true,
      });
      continue;
    }
    if (weekend && def.slot_id === 'd12' && afishaCount >= 2) {
      slots.push({
        ...def,
        type: 'afisha_evening',
        topic: 'Weekend poster for this evening: ONE real event from bank category afisha that suits the user\'s age (profile age), a different one from day slot 3; say what, where and when. Never invent an event.',
        bank: 'afisha',
        afisha: true,
      });
      continue;
    }
    if (def.type === 'gender_tip' && gender !== undefined && gender !== 'male' && gender !== 'female') continue;
    if (def.type === 'country_fact' && !hasCountryFacts) continue;
    if (def.type === 'city_fact' && !hasCityFacts) continue;
    if (def.type === 'watch_or_read' && !hasWatchRead) continue;
    if (def.type === 'interest_fact' && interest !== undefined) {
      if (!interest) continue;
      slots.push({
        ...def,
        interest: interest.key,
        bank_item: bankItemOf(interest.row),
      });
      continue;
    }
    if (learningLanguage && ['foreign_word', 'foreign_recall', 'foreign_answer'].includes(def.type)) {
      slots.push({ ...def, learning_language: learningLanguage.code, language_name: learningLanguage.name });
      continue;
    }
    if (def.type === 'holiday') {
      if (holiday) {
        slots.push({ ...def, bank_item: bankItemOf(holiday.row), holiday_kind: holiday.kind });
      } else {
        holidayReplaced = true;
        slots.push({
          ...def,
          type: 'unusual_fact',
          topic: 'An interesting, surprising fact from the bank, category unusual or science (not the same as other slots).',
          bank: 'unusual',
          holiday_replaced: true,
        });
      }
      continue;
    }
    slots.push({ ...def });
  }
  const assigned = Array.isArray(rows) ? assignBankItems(slots, rows) : slots;
  assigned.holidayReplaced = holidayReplaced;
  return assigned;
}

// ---- model input ----

function computeAge(birthDate) {
  const dob = birthDate ? new Date(birthDate) : null;
  if (!dob || Number.isNaN(dob.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDay = (now.getUTCMonth() - dob.getUTCMonth()) || (now.getUTCDate() - dob.getUTCDate());
  if (monthDay < 0) age -= 1;
  return age >= 0 ? age : null;
}

// Bands only, never exact temperatures (plan section 2: weather = advice, no digits).
function weatherForPayload(weather) {
  const built = weather && weather.forecast === true ? planner.buildForecastWeatherLifehack(weather) : null;
  if (!built) return null;
  const f = built.facts;
  const out = {};
  for (const key of ['day_temp_band', 'morning_temp_band', 'rain_chance', 'uv_level', 'condition_lean']) {
    if (f[key]) out[key] = f[key];
  }
  return Object.keys(out).length > 0 ? out : null;
}

function dayInstructions(languageName) {
  return `You are the voice of a kind, clever AI that lives on the user's phone lock screen. Every glance at the phone shows one short line. You entertain, inform, support, teach and notice things, like a smart warm friend — never a motivational poster or a textbook.

THE DAY IS ONE MONOLOGUE
- This is one day of one conversation with one person. You write all of it in one go: 4 windows (morning, day, evening, night) x 12 phrases, in the fixed slot order you receive.
- Make 3–4 callbacks during the day: in the evening or at night come back to something said in the morning or day (the morning wish, the evening idea turning into a night joke about it, and so on). Mark each callback in the "echoes" field of the later phrase with the slot_id it returns to; otherwise "". Never repeat a text; a callback is a new line that plays on the earlier one.
- Phone data is for yesterday only and is used once, in the morning slot "phone_yesterday". Do not mention the phone anywhere else.
- Advice to rest or sleep: at most ONE in the whole day and only with a clear reason in the data. Otherwise none.
- Tone by window: morning — a fresh start; day — light, curious; evening — calmer, cultural; night — quiet and warm.

TIME
- Write as the person will read it at that moment. The planned date is TODAY for them: say "today" / "this morning", never "tomorrow" (morning weather: "today rain — take an umbrella"). "Tomorrow" (and words derived from it, like "tomorrow's") is allowed only in the night slot "tomorrow_task".

LANGUAGE AND VOICE
- Write natively in ${languageName}. Never translate word for word. Translate every name (holidays, people, places, titles) into that language and write it in that language's script.
- Address the user informally. Use the name only in greeting, the goodnight slot and at most two other phrases.
- Never talk about yourself, never say you are an AI. No lecturing, no commands (except weather advice). No exact temperatures. No empty truisms: after reading, the user learned something, smiled, got a concrete tip, or felt a sincere warm word.
- Never mention the words "list", "bank", "data", "according to data", "source" or anything about where the facts came from.
- Jokes, thoughts, wishes, horoscope, tips, ideas are your own; do not translate jokes or quotes literally.

FACTS
- Facts (science, history, animals, space, holidays, people, traditions, quotes, etc.) come ONLY from the "bank_item" of their slot: use exactly that item and return its id in bank_id. A slot without a "bank_item" is your own ("" in bank_id). Never invent facts, names, dates or numbers.
- A bank text is raw material, not text to translate: retell it briefly in your own words, keep the one striking detail. One item is used by one slot only (a quiz question and its answer share theirs); never repeat a fact, an object or an example in two phrases of this day.
- The holiday slot comes with its own "bank_item": use exactly that item and return its id. Never write that there is no holiday.
- Born-today slot: start with "on this day was born ..." in the user's language, never "today was born".
- Quizzes: the three quizzes of the day have different topics and different answers, each on the fact of its own "bank_item". The question slot asks with 2-3 answer options inside the phrase (up to 60 characters): "Which frog survives winter frozen: tree frog, pond frog or toad?". The very next slot answers with a full phrase and a short explanation (up to 60 characters): "Answer: tree frog - in spring it thaws and hops on". Write both in the user's language.
- Word of the day: morning slot "word_of_day" teaches one modern, useful word of the user's language that widens an adult's vocabulary, with its meaning (a word people really use today; never archaic, obsolete, dialect or slang like "паче" or "ибо"); return the bare word in "word_of_day". Night slot "word_recall" asks "do you remember what «word» means?" and night slot "word_answer" answers "Right: word — meaning" (both in the user's language, naming the same word).
- Foreign language: "learning_language" is the language the user learns. Morning slot "foreign_word" teaches one useful intermediate (B1-B2) word of it, for an adult, with the translation into the user's language: never a beginner word such as hello, thanks, cat, water or a number; return the bare foreign word in "foreign_word". Evening slot "foreign_recall" asks "do you remember how to say «translation» in <language>?" (the translation, not the foreign word, and no answer) and evening slot "foreign_answer" answers "Right: foreign word" - both in the user's language, both about the same word. Never a word from "learned_foreign_words".
- Interest slot: the item in "bank_item" is the fact of the day for the user's interest ("interest"); retell it, return its id. Money and business: only facts and concepts, never advice to buy, sell, invest or save. Sport and health: only facts, never medical advice, treatment, diets or "see a doctor".
- Poster slots (weekends only, types "afisha" and "afisha_evening"): choose ONE event of bank category afisha that fits the user's age (profile age: no children's shows for adults, nothing 18+ for minors); name what, where and when; never invent an event; return its id; the two poster slots use different events.
- Country, city and "what to watch or read" slots use only the bank items given for this user's country and city; a film, series or book keeps its title as people of that country know it, translated or transliterated into the user's language when it has a well-known one.
- "already_seen" (last 3 days) and "learned_words" are what the user already read and learned: do not repeat those facts, jokes, ideas or words, even in different words.
- Slots with "ref" refer to an earlier slot of this day. The tip for men or women (type "gender_tip") is really about being a man or a woman (profile gender), never a general lifehack and never a repeat of the morning lifehack.

LENGTH
- Every slot has "max_chars" (60): never exceed it, counting spaces. Aim for 40–55 characters. The absolute limit is ${MAX_LEN}, longer phrases are discarded. Count before answering; if over, drop details, never cut the end of a thought.

OUTPUT
Only JSON matching the schema: one phrase per slot, in slot order, with slot_id, text, bank_id and echoes; plus "word_of_day" and "foreign_word" ("" when that slot is not in the list).`;
}

function dayResponseFormat(count) {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'lock_screen_day',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          phrases: {
            type: 'array',
            minItems: count,
            maxItems: count,
            items: {
              type: 'object',
              properties: {
                slot_id: { type: 'string' },
                text: { type: 'string' },
                bank_id: { type: 'string' },
                echoes: { type: 'string' },
              },
              required: ['slot_id', 'text', 'bank_id', 'echoes'],
              additionalProperties: false,
            },
          },
          word_of_day: { type: 'string' },
          foreign_word: { type: 'string' },
        },
        required: ['phrases', 'word_of_day', 'foreign_word'],
        additionalProperties: false,
      },
    },
  };
}

function repairResponseFormat() {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'lock_screen_day_repair',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          phrases: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                slot_id: { type: 'string' },
                text: { type: 'string' },
                bank_id: { type: 'string' },
                echoes: { type: 'string' },
              },
              required: ['slot_id', 'text', 'bank_id', 'echoes'],
              additionalProperties: false,
            },
          },
          word_of_day: { type: 'string' },
          foreign_word: { type: 'string' },
        },
        required: ['phrases', 'word_of_day', 'foreign_word'],
        additionalProperties: false,
      },
    },
  };
}

function bankIdOf(row) {
  return `b${row.id}`;
}

function buildDayPayload({
  device, languageCode, dateContext, weatherBands, phoneYesterday, bankRows, slots, seenPhrases, learnedWords, countryCode,
  learningLanguage, learnedForeignWords,
}) {
  const profile = {};
  if (device.name) profile.name = device.name;
  if (device.gender) profile.gender = device.gender;
  const age = computeAge(device.birth_date);
  if (age !== null) profile.age = age;
  const zodiac = planner.zodiacSignForBirthDate(device.birth_date);
  if (zodiac) profile.zodiac = zodiac;
  const personalDay = dateContext ? planner.personalDayNumberForBirthDate(device.birth_date, dateContext.date) : null;
  if (personalDay) profile.numerology = { personal_day_number: personalDay };
  if (device.city_name) profile.city = device.city_name;
  if (countryCode) profile.country = countryCode;

  const payload = {
    lang: languageCode,
    date: dateContext ? dateContext.date : undefined,
    weekday: dateContext ? dateContext.weekday : undefined,
    profile,
    weather_today: weatherBands || undefined,
    phone_yesterday: phoneYesterday || undefined,
    bank: bankRows.map((row) => ({
      id: bankIdOf(row),
      category: row.category,
      country: tagsOfRow(row).find((tag) => typeof tag === 'string' && !tag.includes(':')) || '',
      text: row.content_text,
    })),
    learning_language: learningLanguage ? learningLanguage.name : undefined,
    learned_words: learnedWords,
    learned_foreign_words: learnedForeignWords && learnedForeignWords.length > 0 ? learnedForeignWords : undefined,
    slots: slots.map((slot) => {
      const out = {
        slot_id: slot.slot_id,
        window: slot.window,
        type: slot.type,
        topic: slot.topic,
        max_chars: slot.max_chars,
      };
      if (slot.bank) out.bank = slot.bank;
      if (slot.ref) out.ref = slot.ref;
      if (slot.bank_item) out.bank_item = slot.bank_item;
      if (slot.interest) out.interest = slot.interest;
      return out;
    }),
    // Last: the variable, per-device part (what this person already read).
    already_seen: seenPhrases,
  };
  return payload;
}

// ---- model call ----

let clientFactory = null;

function getClient() {
  if (clientFactory) {
    return clientFactory();
  }
  const OpenAI = require('openai');
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function dayModel() {
  return process.env.OPENAI_DAY_MODEL || DAY_MODEL_DEFAULT;
}

function dayEffort() {
  return String(process.env.OPENAI_DAY_REASONING_EFFORT || DAY_EFFORT_DEFAULT).trim().toLowerCase();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(err) {
  const status = err && typeof err.status === 'number' ? err.status : null;
  return status === null || status === 429 || (status >= 500 && status < 600);
}

// Same line as the batch's usage log, one per call (scope=day, scope=day_repair).
function logDayUsage(scope, response) {
  const usage = response && response.usage;
  if (!usage) return null;
  const cached = usage.prompt_tokens_details && Number.isFinite(usage.prompt_tokens_details.cached_tokens)
    ? usage.prompt_tokens_details.cached_tokens : 0;
  const reasoning = usage.completion_tokens_details && Number.isFinite(usage.completion_tokens_details.reasoning_tokens)
    ? usage.completion_tokens_details.reasoning_tokens : 0;
  console.log(`OPENAI_USAGE scope=${scope} model=${dayModel()} prompt_tokens=${usage.prompt_tokens} completion_tokens=${usage.completion_tokens} reasoning_tokens=${reasoning} total_tokens=${usage.total_tokens} cached_tokens=${cached} reasoning_effort=${dayEffort()}`);
  return { prompt: usage.prompt_tokens, completion: usage.completion_tokens, reasoning };
}

async function callModel(messages, responseFormat, timeoutMs) {
  const params = {
    model: dayModel(),
    messages,
    response_format: responseFormat,
    max_completion_tokens: DAY_MAX_COMPLETION_TOKENS,
    reasoning_effort: dayEffort(),
  };
  return getClient().chat.completions.create(params, { timeout: timeoutMs, maxRetries: 0 });
}

function parseDayResponse(response) {
  const content = response && response.choices && response.choices[0] && response.choices[0].message
    && response.choices[0].message.content;
  const parsed = JSON.parse(content);
  if (!parsed || !Array.isArray(parsed.phrases)) {
    throw new Error('response did not contain phrases array');
  }
  return parsed;
}

async function callDayWithRetry(messages, count) {
  let lastErr = null;
  for (let attempt = 1; attempt <= DAY_MAX_ATTEMPTS; attempt += 1) {
    const startedMs = Date.now();
    try {
      const response = await callModel(messages, dayResponseFormat(count), DAY_TIMEOUT_MS);
      const usage = logDayUsage('day', response);
      const parsed = parseDayResponse(response);
      console.log(`OPENAI_ATTEMPT scope=day result=success attempt=${attempt}/${DAY_MAX_ATTEMPTS} duration_ms=${Date.now() - startedMs}`);
      return { parsed, usage, ms: Date.now() - startedMs };
    } catch (err) {
      lastErr = err;
      console.error(`OPENAI_ATTEMPT scope=day result=error attempt=${attempt}/${DAY_MAX_ATTEMPTS} duration_ms=${Date.now() - startedMs} err_name=${err.name || 'Error'} err_status=${err.status || 'none'} err_message="${String(err.message || '').replace(/\s+/g, ' ').slice(0, 200)}"`);
      const retry = err instanceof SyntaxError || err.message === 'response did not contain phrases array' || isRetryable(err);
      if (!retry || attempt === DAY_MAX_ATTEMPTS) break;
      await sleep(1000);
    }
  }
  throw lastErr || new Error('openai_retry_exhausted');
}

// ---- validation ----

function languageOk(text, languageCode) {
  const language = generator.SUPPORTED_LANGUAGES[languageCode];
  return !language || language.scriptCheck.test(text);
}

// Returns a reason string or null. Hard checks only (length, empty, exact repeat of something already
// sent to this device, wrong script); style and meaning are the model's job.
function rejectionReason(text, slot, languageCode, archive) {
  const result = validateLockScreenText(text, { maxLength: MAX_LEN, slotType: slot.type });
  if (!result.ok) return result.detail || result.reason;
  if (!languageOk(text, languageCode)) return 'wrong_language';
  if (findRepeat(archive, text, REPAIR_EXEMPT.has(slot.type) ? slot.type : null)) return 'repeat_of_sent';
  return null;
}

// Slots that must be rewritten together with a rejected one, so a pair stays consistent.
function repairGroup(slotId, slotIds) {
  // A rejected word recall/answer (of the word of the day or of the foreign word) is rewritten as a pair
  // (the taught word itself stays); a rejected teaching phrase takes the whole trio with it.
  const groups = [...QUIZ_PAIRS];
  const teachIds = new Set(WORD_TRIOS.map((trio) => trio.teach));
  for (const trio of WORD_TRIOS) groups.push([trio.recall, trio.answer], [trio.teach, trio.recall, trio.answer]);
  const out = new Set([slotId]);
  for (const group of groups) {
    if (group.includes(slotId) && (!teachIds.has(group[0]) || slotId === group[0])) {
      group.forEach((id) => slotIds.has(id) && out.add(id));
    }
  }
  return [...out];
}

async function repairRejected({ rejected, accepted, slotsById, languageName, payloadBase, languageCode, archive }) {
  const slotIds = new Set(slotsById.keys());
  const group = new Set();
  for (const slotId of Object.keys(rejected)) repairGroup(slotId, slotIds).forEach((id) => group.add(id));
  const items = [...group].map((slotId) => {
    const slot = slotsById.get(slotId);
    const item = {
      slot_id: slotId,
      type: slot.type,
      topic: slot.topic,
      max_chars: slot.max_chars,
    };
    if (slot.bank_item) item.bank_item = slot.bank_item;
    if (slot.ref && accepted[slot.ref]) item.referenced_phrase = accepted[slot.ref].text;
    if (rejected[slotId]) {
      item.original_text = rejected[slotId].text;
      item.rejection_reason = rejected[slotId].reason;
    } else if (accepted[slotId]) {
      item.keep_consistent_with_original_text = accepted[slotId].text;
    }
    return item;
  });
  const messages = [
    {
      role: 'system',
      content: `Rewrite the listed lock-screen phrases in ${languageName}. For each slot with "rejection_reason": fix exactly that problem and keep the meaning (too_long: shorten to 55-60 characters, never more than max_chars, drop details, never cut the end of a thought; repeat_of_sent: say it differently; wrong_language: write it in the right language). A slot with "keep_consistent_with_original_text" is the other half of a pair: rewrite it to fit its partner. Do not repeat original_text. Facts only from the given bank_item/bank, never invented. A "foreign_recall" asks "do you remember how to say «translation» in <language>?" and its "foreign_answer" says "Right: <foreign word>"; never a word from learned_foreign_words. Return JSON: phrases (one per slot, with slot_id, text, bank_id, echoes), word_of_day (the word of the day if its teaching slot is included, else "") and foreign_word (the bare foreign word if its teaching slot is included, else "").`,
    },
    {
      role: 'user',
      content: JSON.stringify({
        lang: payloadBase.lang,
        profile: payloadBase.profile,
        bank: payloadBase.bank,
        learned_words: payloadBase.learned_words,
        learning_language: payloadBase.learning_language,
        learned_foreign_words: payloadBase.learned_foreign_words,
        slots: items,
        already_seen: payloadBase.already_seen,
      }),
    },
  ];
  const startedMs = Date.now();
  const response = await callModel(messages, repairResponseFormat(), REPAIR_TIMEOUT_MS);
  const usage = logDayUsage('day_repair', response);
  const parsed = parseDayResponse(response);
  const fixed = new Map();
  for (const item of parsed.phrases) {
    if (item && typeof item.slot_id === 'string' && group.has(item.slot_id) && typeof item.text === 'string') {
      fixed.set(item.slot_id, item);
    }
  }
  return {
    fixed,
    word: typeof parsed.word_of_day === 'string' ? parsed.word_of_day.trim() : '',
    foreignWord: typeof parsed.foreign_word === 'string' ? parsed.foreign_word.trim() : '',
    usage, ms: Date.now() - startedMs, requested: group.size };
}

// ---- styles ----

// One style per phrase, different inside a window (12 phrases, 27 styles), and the first style of a
// window differs from the last of the previous one.
function assignStyleIds(phrases, rng = Math.random) {
  const result = [];
  let previous = null;
  for (const window of WINDOW_ORDER) {
    const inWindow = phrases.filter((p) => p.window === window);
    const pool = STYLE_IDS.slice();
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    if (previous && pool[0] === previous) pool.push(pool.shift());
    inWindow.forEach((phrase, i) => result.push({ ...phrase, style_id: pool[i % pool.length] }));
    if (inWindow.length > 0) previous = pool[(inWindow.length - 1) % pool.length];
  }
  return result;
}

// ---- generation ----

const DATE_BOUND_CATEGORIES = new Set(['holiday', 'on_this_day', 'born_today']);

// The rows behind the "bank_item" of the slots (each once): what the model is shown as its bank.
function assignedRows(slots, rows) {
  const byId = new Map(rows.map((row) => [`b${row.id}`, row]));
  const out = [];
  const seen = new Set();
  for (const slot of slots) {
    const id = slot.bank_item && slot.bank_item.id;
    if (id && !seen.has(id) && byId.has(id)) {
      seen.add(id);
      out.push(byId.get(id));
    }
  }
  return out;
}

// The old Kazakhstan-only bank categories (rows of the last 45 days) are read as the new ones.
function normalizeBankRow(row) {
  if (row.category === 'country_kz') return { ...row, category: 'country_fact', tags: ['KZ'] };
  if (row.category === 'city_astana') return { ...row, category: 'city_fact', tags: ['KZ', cityTag('Astana')] };
  return row;
}

// The bank rows this user may be offered: facts about the user's own country and city only (a city fact
// needs the city, a country fact the country), films and books of the user's country (else the world-famous
// ones), events of the user's city for this very day. The interest facts are picked separately (the
// interest of the day) and never offered as a whole.
function bankRowsForUser(rows, { countryCode, cityName, date }) {
  const country = typeof countryCode === 'string' && countryCode ? countryCode.toUpperCase() : null;
  const city = cityName ? cityTag(cityName) : null;
  const out = [];
  const watchLocal = [];
  const watchGlobal = [];
  for (const raw of rows) {
    const row = normalizeBankRow(raw);
    const tags = tagsOfRow(row);
    if (row.category === 'country_fact') {
      if (country && tags.includes(country)) out.push(row);
    } else if (row.category === 'city_fact') {
      if (city && tags.includes(city)) out.push(row);
    } else if (row.category === 'watch_read') {
      if (country && tags.includes(country)) watchLocal.push(row);
      else if (tags.includes('global')) watchGlobal.push(row);
    } else if (row.category === 'afisha') {
      const dateTag = tags.find((tag) => typeof tag === 'string' && tag.startsWith('date:'));
      if (city && tags.includes(city) && (!dateTag || !date || dateTag === `date:${date}`)) out.push(row);
    } else if (!row.category.startsWith(rotation.INTEREST_CATEGORY_PREFIX)) {
      out.push(row);
    }
  }
  return out.concat(watchLocal.length > 0 ? watchLocal : watchGlobal);
}

/**
 * Generates one device's whole day.
 *
 * input: { device, languageCode, learningLanguage?, dateContext, weather, countryCode, phoneYesterday, bank: { rows } }
 * Returns { phrases, source, reason?, word, foreign_word, interest, dropped, usage, repair, slots } where phrases are
 * [{ slot_id, window, position, type, text, style_id, requires_shown_text?, interest?, learning_language? }].
 * Never throws; a failed call returns { phrases: [], source: 'fallback', reason } (nothing is substituted: an
 * empty day is better than a made-up one).
 */
async function generateDay(input) {
  const startedMs = Date.now();
  const { device, languageCode, dateContext, weather, countryCode, phoneYesterday } = input;
  const supported = generator.SUPPORTED_LANGUAGES;
  const languageName = (supported[languageCode] || supported.en).name;
  const learningCode = rotation.resolveLearningLanguage({
    requested: input.learningLanguage, stored: device.learning_language, userLanguageCode: languageCode, supported,
  });
  const learning = { code: learningCode, name: supported[learningCode].name };
  const fail = (reason) => ({ phrases: [], source: 'fallback', reason, word: null, foreign_word: null, interest: null, dropped: [], usage: null, repair: null, slots: [] });

  if (!process.env.OPENAI_API_KEY && !clientFactory) {
    return fail('no_api_key');
  }

  // Bank rows this device may use: not already shown to it (hard filter), no leftover holiday rows
  // other than through the holiday slot.
  const shownFacts = loadShownFacts(device.device_id);
  // "NONE:" rows are the model's notes that a required day does not exist (parseBankItems never stores them);
  // ignored here too, so that a note can never be shown as a holiday.
  // Holiday, "on this day" and "born today" are only ever for the local date of this day: a row of another
  // bank date (a holiday of yesterday's or Friday's bank) is dropped here too, whatever the caller passed.
  const dayDate = dateContext ? dateContext.date : null;
  const allRows = ((input.bank && input.bank.rows) || [])
    .filter((row) => !/^none:/i.test(String(row.content_text || '')))
    .filter((row) => !DATE_BOUND_CATEGORIES.has(row.category) || !row.bank_date || !dayDate || row.bank_date === dayDate);
  const holiday = pickHoliday(allRows, countryCode);
  const notShown = allRows.filter((row) => !isFactShown(shownFacts, row.category, row.content_text));
  const usableRows = notShown.filter((row) => row.category !== 'holiday');
  const holidayUsable = holiday && !isFactShown(shownFacts, 'holiday', holiday.row.content_text) ? holiday : null;

  const localDate = dateContext ? dateContext.date : null;
  const userRows = bankRowsForUser(usableRows, { countryCode, cityName: device.city_name, date: localDate });
  const countOf = (category) => userRows.filter((row) => row.category === category).length;
  // The interest of the day: the next one of the device's circle that still has a fact nobody showed it.
  const interest = rotation.pickInterestOfDay(device, (key) => usableRows
    .find((row) => row.category === rotation.interestCategory(key)) || null);

  const weatherBands = weatherForPayload(weather);
  const slots = buildDaySlots({
    holiday: holidayUsable,
    hasWeather: Boolean(weatherBands),
    hasPhone: Boolean(phoneYesterday),
    weekend: rotation.isWeekendDate(localDate),
    afishaCount: countOf('afisha'),
    hasCountryFacts: countOf('country_fact') > 0,
    hasCityFacts: countOf('city_fact') > 0,
    hasWatchRead: countOf('watch_read') > 0,
    interest,
    learningLanguage: learning,
    rows: userRows,
    gender: device.gender || '',
  });
  const slotsById = new Map(slots.map((slot) => [slot.slot_id, slot]));

  const learnedForeignWords = rotation.loadLearnedForeignWords(device.device_id, learning.code);
  const learnedForeignSet = new Set(learnedForeignWords.map(rotation.normalizeWord));
  const payloadBase = buildDayPayload({
    device,
    languageCode,
    dateContext,
    weatherBands,
    phoneYesterday,
    bankRows: assignedRows(slots, userRows.concat(holidayUsable ? [holidayUsable.row] : [], interest ? [interest.row] : [])),
    slots,
    seenPhrases: loadSeenPhrases(device.device_id),
    learnedWords: loadLearnedWords(device.device_id),
    countryCode,
    learningLanguage: learning,
    learnedForeignWords,
  });
  const messages = [
    { role: 'system', content: dayInstructions(languageName) },
    { role: 'user', content: JSON.stringify(payloadBase) },
  ];

  let first;
  try {
    first = await callDayWithRetry(messages, slots.length);
  } catch (err) {
    return fail(err instanceof SyntaxError ? 'parse_or_schema_error' : 'openai_error');
  }

  const archive = loadSentArchive(device.device_id);
  const accepted = {};
  const rejected = {};
  const answered = new Set();
  // The taught words by teaching slot: the word of the day (m7) and the foreign word (m10).
  const words = {
    [WORD_SLOTS.teach]: typeof first.parsed.word_of_day === 'string' ? first.parsed.word_of_day.trim() : '',
    [FOREIGN_SLOTS.teach]: typeof first.parsed.foreign_word === 'string' ? first.parsed.foreign_word.trim() : '',
  };
  // Why the foreign word cannot be taught: already learned by this device, or a beginner word (task 28).
  const foreignProblem = (word) => {
    if (!word) return null;
    const normalized = rotation.normalizeWord(word);
    if (BASIC_FOREIGN_WORDS.has(normalized)) return 'foreign_word_basic';
    return learnedForeignSet.has(normalized) ? 'foreign_word_repeat' : null;
  };
  // The fact of a slot is the one the server gave it, whatever id the model wrote.
  const bankIdOfSlot = (slot) => (slot.bank_item ? slot.bank_item.id : '');
  for (const item of first.parsed.phrases) {
    const slot = item && slotsById.get(item.slot_id);
    if (!slot || answered.has(item.slot_id) || typeof item.text !== 'string') continue;
    answered.add(item.slot_id);
    const text = item.text.trim();
    let reason = rejectionReason(text, slot, languageCode, archive);
    // A foreign word this device has already learned is never taught again.
    if (!reason && item.slot_id === FOREIGN_SLOTS.teach) reason = foreignProblem(words[FOREIGN_SLOTS.teach]);
    const entry = { text, bank_id: bankIdOfSlot(slot), echoes: typeof item.echoes === 'string' ? item.echoes : '' };
    if (reason) rejected[item.slot_id] = { ...entry, reason };
    else accepted[item.slot_id] = entry;
  }
  // A slot the model skipped entirely is missing, not rejected: it is dropped (no repair for it).
  const missing = slots.filter((slot) => !answered.has(slot.slot_id)).map((slot) => slot.slot_id);

  // Repair: one call for everything rejected (too long, repeat, wrong script) plus the other half of its pair.
  // A phrase that is still longer than the limit after it gets ONE more call (round 2), only for those phrases
  // and their pair (quiz question + answer, word recall + answer). Whatever is still bad afterwards is dropped.
  let repair = null;
  for (let round = 1; round <= MAX_REPAIR_ROUNDS; round += 1) {
    const pending = round === 1 ? rejected : Object.fromEntries(
      Object.entries(rejected).filter(([, entry]) => String(entry.reason).startsWith('too_long')));
    if (Object.keys(pending).length === 0) break;
    const originalRejectedCount = Object.keys(pending).length;
    try {
      const outcome = await repairRejected({ rejected: pending, accepted, slotsById, languageName, payloadBase, languageCode, archive });
      repair = round === 1
        ? { rejected: originalRejectedCount, requested: outcome.requested, usage: outcome.usage, ms: outcome.ms, rounds: 1 }
        : { ...repair, rounds: 2, second: { rejected: originalRejectedCount, requested: outcome.requested, usage: outcome.usage, ms: outcome.ms } };
      if (outcome.word && slotsById.has(WORD_SLOTS.teach) && (rejected[WORD_SLOTS.teach] || outcome.fixed.has(WORD_SLOTS.teach))) {
        words[WORD_SLOTS.teach] = outcome.word;
      }
      if (outcome.foreignWord && slotsById.has(FOREIGN_SLOTS.teach) && (rejected[FOREIGN_SLOTS.teach] || outcome.fixed.has(FOREIGN_SLOTS.teach))) {
        words[FOREIGN_SLOTS.teach] = outcome.foreignWord;
      }
      for (const [slotId, item] of outcome.fixed) {
        const slot = slotsById.get(slotId);
        const text = item.text.trim();
        let reason = rejectionReason(text, slot, languageCode, archive);
        if (!reason && slotId === FOREIGN_SLOTS.teach) reason = foreignProblem(words[FOREIGN_SLOTS.teach]);
        delete accepted[slotId];
        if (reason) {
          rejected[slotId] = { text, bank_id: bankIdOfSlot(slot), echoes: item.echoes || '', reason };
        } else {
          delete rejected[slotId];
          accepted[slotId] = { text, bank_id: bankIdOfSlot(slot), echoes: typeof item.echoes === 'string' ? item.echoes : '' };
        }
      }
    } catch (err) {
      console.error(`OPENAI_ATTEMPT scope=day_repair result=error err_name=${err.name || 'Error'} err_status=${err.status || 'none'}`);
      repair = round === 1 ? { rejected: originalRejectedCount, error: true } : { ...repair, second: { error: true } };
      break;
    }
  }

  // Pairs. A quiz question and its answer stand or fall together. A recall and its answer (night 8 + 9,
  // evening 2 + 3) are always together and need the word taught in the morning (morning 7 / morning 10).
  const dropped = [];
  const drop = (slotId, reason) => {
    if (accepted[slotId]) {
      delete accepted[slotId];
      dropped.push({ slot_id: slotId, reason });
    }
  };
  for (const slotId of Object.keys(rejected)) dropped.push({ slot_id: slotId, reason: rejected[slotId].reason });
  for (const slotId of missing) dropped.push({ slot_id: slotId, reason: 'missing' });
  for (const [a, b] of QUIZ_PAIRS) {
    if (!accepted[a] || !accepted[b]) {
      drop(a, 'pair_incomplete');
      drop(b, 'pair_incomplete');
    }
  }
  for (const trio of WORD_TRIOS) {
    if (!accepted[trio.recall] || !accepted[trio.answer]) {
      drop(trio.recall, 'pair_incomplete');
      drop(trio.answer, 'pair_incomplete');
    }
    if (slotsById.has(trio.teach) && !accepted[trio.teach]) {
      drop(trio.recall, 'word_not_taught');
      drop(trio.answer, 'word_not_taught');
      words[trio.teach] = '';
    }
  }
  if (dropped.length > 0) {
    console.warn(`DAY_SLOTS_DROPPED device_id=${device.device_id} ${dropped.map((d) => `${d.slot_id}:${d.reason}`).join(' ')}`);
  }

  // The words the person was taught today (null if the teaching phrase did not survive).
  const wordTaught = accepted[WORD_SLOTS.teach] ? (words[WORD_SLOTS.teach] || accepted[WORD_SLOTS.teach].text) : null;
  const foreignTaught = accepted[FOREIGN_SLOTS.teach] ? (words[FOREIGN_SLOTS.teach] || accepted[FOREIGN_SLOTS.teach].text) : null;

  const bankTextById = new Map(payloadBase.bank.map((row) => [row.id, row.text]));
  const ordered = slots
    .filter((slot) => accepted[slot.slot_id])
    .map((slot) => {
      const item = {
        slot_id: slot.slot_id,
        window: slot.window,
        position: slot.position,
        type: slot.type,
        text: accepted[slot.slot_id].text,
      };
      // The phone (and the server on later requests) may skip a recall/answer pair if the morning phrase
      // it asks about was never actually shown.
      const trio = WORD_TRIOS.find((t) => t.recall === slot.slot_id || t.answer === slot.slot_id);
      if (trio && accepted[trio.teach]) item.requires_shown_text = accepted[trio.teach].text;
      // The phone writes the rubric from type (+ interest / learning_language).
      if (slot.interest) item.interest = slot.interest;
      if (slot.learning_language) item.learning_language = slot.learning_language;
      return item;
    });
  const phrases = assignStyleIds(ordered);

  // Memory: the bank facts really used (so they are not offered again) and the sent texts (exact-repeat archive).
  const factSlots = slots
    .filter((slot) => accepted[slot.slot_id] && accepted[slot.slot_id].bank_id && bankTextById.has(accepted[slot.slot_id].bank_id))
    .map((slot) => ({
      slot_id: slot.slot_id,
      type: slot.type,
      source: 'daily_bank',
      facts: { text: bankTextById.get(accepted[slot.slot_id].bank_id) },
    }));
  const factSlotIds = new Set(factSlots.map((slot) => slot.slot_id));
  recordSentContent(device.device_id, factSlots.concat(slots.filter((slot) => !factSlotIds.has(slot.slot_id))), phrases);
  if (wordTaught && dateContext) {
    db.prepare('INSERT INTO device_learning_memory (device_id, word_key, word_text, learned_local_date) VALUES (?, ?, ?, ?)')
      .run(device.device_id, `day:${dateContext.date}`, wordTaught, dateContext.date);
  }
  // The foreign word is kept per device and language, the interest pointer moves on only when its fact went out.
  if (foreignTaught) {
    rotation.recordForeignWord(device.device_id, learning.code, foreignTaught, localDate);
  }
  const interestShown = interest && accepted.n2 ? interest.key : null;
  if (interestShown) {
    rotation.recordInterest(device.device_id, interestShown, localDate);
  }

  const echoes = slots.filter((slot) => accepted[slot.slot_id] && accepted[slot.slot_id].echoes)
    .map((slot) => `${slot.slot_id}->${accepted[slot.slot_id].echoes}`);
  return {
    phrases,
    source: 'openai',
    word: wordTaught,
    foreign_word: foreignTaught,
    learning_language: learning.code,
    interest: interestShown,
    dropped,
    echoes,
    usage: first.usage,
    repair,
    slots,
    generation_ms: Date.now() - startedMs,
    model_ms: first.ms,
    holiday_kind: holidayUsable ? holidayUsable.kind : 'replaced_by_fact',
  };
}

// ---- serving ----

const wordWasShownStatement = db.prepare('SELECT 1 FROM shown_phrases WHERE device_id = ? AND text = ? LIMIT 1').pluck();

// The night word recall (night 8 + 9) is shown only if the morning word was really shown. For a device
// that reports shown phrases, a plan requested at or after `afterTime` (local, HH:MM; the morning is
// over) loses the pair when the morning word is not among its reports. Before that time the pair stays
// (nothing could have been shown yet) and carries requires_shown_text so the phone can apply the same rule.
// A device that never reports (older app) keeps the pair.
// The same rule holds for the foreign-word pair (evening 2 + 3, needs morning 10): every distinct
// requires_shown_text is checked on its own.
function applyWordPairRule(phrases, deviceId, localTime, afterTime = '15:00') {
  const required = [...new Set(phrases.filter((p) => p.requires_shown_text).map((p) => p.requires_shown_text))];
  if (required.length === 0 || !deviceReportsShown(deviceId)) {
    return phrases;
  }
  if (typeof localTime !== 'string' || localTime < afterTime) {
    return phrases;
  }
  const notShown = new Set(required.filter((text) => wordWasShownStatement.get(deviceId, text) !== 1));
  return notShown.size === 0 ? phrases : phrases.filter((p) => !notShown.has(p.requires_shown_text));
}

module.exports = {
  MAX_LEN,
  QUIZ_PAIRS,
  WORD_SLOTS,
  FOREIGN_SLOTS,
  slotDefinitions,
  assignBankItems,
  BASIC_FOREIGN_WORDS,
  bankRowsForUser,
  buildDaySlots,
  pickHoliday,
  generateDay,
  applyWordPairRule,
  assignStyleIds,
  _test: {
    setClientFactory(factory) {
      clientFactory = factory;
    },
    dayInstructions,
    buildDayPayload,
    rejectionReason,
    weatherForPayload,
    dayResponseFormat,
  },
};
