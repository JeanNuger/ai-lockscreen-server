const { STYLE_IDS, BATCH_SIZE } = require('./constants');
const {
  selectBankItemsForDevice,
  recordShownCategories,
  getBankDateString,
  BANK_CATEGORIES,
} = require('./dailyContentBank');
const {
  getRecentContentMemory,
  recordShownContentMemory,
} = require('./contentMemory');
const {
  getRecallCandidate,
  recordLearnedWords,
  recordRecalledWords,
} = require('./learningMemory');
const { planSlots } = require('./slotPlanner');
const {
  hasQuestionMark,
  validateLockScreenText,
} = require('./textFilter');

// Absolute hard cap, backed by a real on-device measurement of the Android
// lock-screen text area (TextWallpaperService.java's safe zone / StaticLayout
// wrapping at the current font size/width) -- text this long or shorter is
// guaranteed to fit without visual overflow, regardless of length_hint below.
const LOCK_SCREEN_TEXT_MAX_LENGTH = 70;

// `focus` (content-improvement follow-up, req 3 "усилить различие между
// morning/day/evening/night") is a short, data-only mood/topic steer for the
// currently-selected, non-fixed-type slots (free_ai_thought/everyday_lifehack/
// smart_humor_observation/city_afisha/context_signal/seasonal and friends --
// greeting_name/goodnight_care/weather_lifehack/holiday_today/history_today/
// word_learning already have their own explicit per-type instructions in
// buildSystemPrompt and are unaffected). Travels inside now.window (see
// buildContextPrompt) as ordinary JSON data, not a system-prompt change, so
// buildSystemPrompt stays a pure function of languageCode only -- the
// existing OpenAI-side prompt-cache rationale for that (see buildSystemPrompt's
// own comment) is preserved unchanged; only ONE static instruction line
// (added there) tells the model to read this field.
const WINDOW_CONTEXT = {
  morning: { id: 'morning', range: '05:00-11:00', focus: 'старт дня, лёгкая энергия, ненавязчивое планирование' },
  day: { id: 'day', range: '11:00-15:00', focus: 'рабочий темп, фокус, бытовые наблюдения' },
  evening: { id: 'evening', range: '15:00-20:00', focus: 'переключение с дел, восстановление, итоги дня' },
  night: { id: 'night', range: '20:00-05:00', focus: 'спокойные мягкие мысли, минимум активного тона и советов' },
};

// One entry per SUPPORTED_LANGUAGES code -- covers every language the app
// actually generates in, not just ru/en, so the date/weekday guard applies
// uniformly regardless of resolveTargetLanguageCode's result. Aliases are
// deliberately minimal: just the forms needed to catch "Tomorrow is Friday"/
// "Today is Saturday" and their natural equivalents (a couple of inflected
// forms where a language needs them, e.g. Russian accusative "пятницу",
// Portuguese's short "segunda" alongside "segunda-feira") -- not a full
// grammatical case/conjugation table.
const WEEKDAY_ALIASES = {
  ru: {
    Monday: ['понедельник'],
    Tuesday: ['вторник'],
    Wednesday: ['среда', 'среду'],
    Thursday: ['четверг'],
    Friday: ['пятница', 'пятницу'],
    Saturday: ['суббота', 'субботу'],
    Sunday: ['воскресенье'],
  },
  en: {
    Monday: ['monday'],
    Tuesday: ['tuesday'],
    Wednesday: ['wednesday'],
    Thursday: ['thursday'],
    Friday: ['friday'],
    Saturday: ['saturday'],
    Sunday: ['sunday'],
  },
  fr: {
    Monday: ['lundi'],
    Tuesday: ['mardi'],
    Wednesday: ['mercredi'],
    Thursday: ['jeudi'],
    Friday: ['vendredi'],
    Saturday: ['samedi'],
    Sunday: ['dimanche'],
  },
  es: {
    Monday: ['lunes'],
    Tuesday: ['martes'],
    Wednesday: ['miércoles', 'miercoles'],
    Thursday: ['jueves'],
    Friday: ['viernes'],
    Saturday: ['sábado', 'sabado'],
    Sunday: ['domingo'],
  },
  pt: {
    Monday: ['segunda-feira', 'segunda'],
    Tuesday: ['terça-feira', 'terça', 'terca-feira', 'terca'],
    Wednesday: ['quarta-feira', 'quarta'],
    Thursday: ['quinta-feira', 'quinta'],
    Friday: ['sexta-feira', 'sexta'],
    Saturday: ['sábado', 'sabado'],
    Sunday: ['domingo'],
  },
  de: {
    Monday: ['montag'],
    Tuesday: ['dienstag'],
    Wednesday: ['mittwoch'],
    Thursday: ['donnerstag'],
    Friday: ['freitag'],
    Saturday: ['samstag'],
    Sunday: ['sonntag'],
  },
  zh: {
    Monday: ['星期一', '周一'],
    Tuesday: ['星期二', '周二'],
    Wednesday: ['星期三', '周三'],
    Thursday: ['星期四', '周四'],
    Friday: ['星期五', '周五'],
    Saturday: ['星期六', '周六'],
    Sunday: ['星期日', '星期天', '周日'],
  },
  ja: {
    Monday: ['月曜日', '月曜'],
    Tuesday: ['火曜日', '火曜'],
    Wednesday: ['水曜日', '水曜'],
    Thursday: ['木曜日', '木曜'],
    Friday: ['金曜日', '金曜'],
    Saturday: ['土曜日', '土曜'],
    Sunday: ['日曜日', '日曜'],
  },
  ko: {
    Monday: ['월요일'],
    Tuesday: ['화요일'],
    Wednesday: ['수요일'],
    Thursday: ['목요일'],
    Friday: ['금요일'],
    Saturday: ['토요일'],
    Sunday: ['일요일'],
  },
  it: {
    Monday: ['lunedì', 'lunedi'],
    Tuesday: ['martedì', 'martedi'],
    Wednesday: ['mercoledì', 'mercoledi'],
    Thursday: ['giovedì', 'giovedi'],
    Friday: ['venerdì', 'venerdi'],
    Saturday: ['sabato'],
    Sunday: ['domenica'],
  },
};

const RELATIVE_DAY_MARKERS = {
  ru: {
    today: ['сегодня'],
    tomorrow: ['завтра'],
  },
  en: {
    today: ['today'],
    tomorrow: ['tomorrow'],
  },
  fr: {
    today: ["aujourd'hui", 'aujourdhui'],
    tomorrow: ['demain'],
  },
  es: {
    today: ['hoy'],
    tomorrow: ['mañana', 'manana'],
  },
  pt: {
    today: ['hoje'],
    tomorrow: ['amanhã', 'amanha'],
  },
  de: {
    today: ['heute'],
    tomorrow: ['morgen'],
  },
  zh: {
    today: ['今天'],
    tomorrow: ['明天'],
  },
  ja: {
    today: ['今日'],
    tomorrow: ['明日'],
  },
  ko: {
    today: ['오늘'],
    tomorrow: ['내일'],
  },
  it: {
    today: ['oggi'],
    tomorrow: ['domani'],
  },
};

const BATTERY_TERMS = {
  ru: ['заряд', 'заряда', 'заряж', 'батаре', 'аккумулятор'],
  en: ['battery', 'charge'],
};

const UNLOCK_TERMS = {
  ru: ['разблокиров'],
  en: ['unlock', 'unlocks'],
};

// JS's \b is defined in terms of \w, which is ASCII-only (`[A-Za-z0-9_]`) --
// Cyrillic letters are never "word characters" to it, so a Cyrillic-only
// pattern like /\bпора\b/ never matches anything at all (found while adding
// tests for the patterns below: every RU pattern silently no-op'd). This
// builds an equivalent boundary using a lookaround against an explicit
// Latin+Cyrillic+digit+underscore class instead, so RU patterns actually
// fire. EN patterns don't need this (plain ASCII \b already works for them).
const WORD_CHARS = 'A-Za-zА-Яа-яЁё0-9_';
function ruWordBoundaryPattern(source) {
  return new RegExp(`(?<![${WORD_CHARS}])(?:${source})(?![${WORD_CHARS}])`, 'i');
}

const UNSUPPORTED_CONTEXT_PATTERNS = {
  traffic: {
    ru: ['в\\s+пробк[аеуы]', 'пробк[аеуы]'].map(ruWordBoundaryPattern),
    en: [/\btraffic\s+jam\b/i, /\bstuck\s+in\s+traffic\b/i, /\bin\s+traffic\b/i],
  },
};

const COACHING_PATTERNS = {
  ru: [
    'не\\s+забудь',
    'тебе\\s+стоит',
    'пора\\s+[а-яё]+',
    'попробуй',
    'попробовать',
    'сделай',
    'дай\\s+себе',
    'запланируй',
    'экспериментируй',
  ].map(ruWordBoundaryPattern),
  en: [
    /\bdon't\s+forget\b/i,
    /\byou\s+should\b/i,
    /\bit'?s\s+time\s+to\b/i,
    /\btry\s+(?:to\s+)?[a-z]/i,
    /\bremember\s+to\b/i,
    /\bstart\s+with\b/i,
    /\bfocus\s+on\b/i,
  ],
};

// FALLBACK_PHRASES: the offline/failure path (no OPENAI_API_KEY configured,
// the OpenAI call itself fails, the whole batch comes back unusable, or an
// individual phrase fails its language check below). Translated into all 10
// supported languages so this path degrades in the device's own language
// instead of always falling back to English. The fallback copy is deliberately
// warm, kind, and supportive -- the product is "a living, kind companion inside
// the phone", not a neutral technical assistant, and the fallback path (the one
// moment the AI genuinely has nothing to say) must not sound colder than the
// AI-generated content around it (task history, 2026-09-21: replaced an earlier
// neutral/practical-tip set that read as flat and emotionless). Still one-way,
// question-free, non-factual, no imperative openers, and free of every banned
// postcard/poetry word (see textFilter.js STOP_PHRASES) -- warmth without
// slipping back into the "believe in yourself" cliche the system prompt itself
// bans, and without inventing facts about the specific user.
//
// Rotation: FALLBACK_PHRASES[lang] is 5 sets of 12 phrases each (not a flat
// list of 12) -- see currentFallbackSetIndex()/activeFallbackPhrases() below.
// A real OpenAI outage lasting more than a few hours must not show the exact
// same 12 phrases the whole time; the active set is picked by calendar day
// (UTC) modulo 5, so it actually changes every day, well inside the "at least
// once every 5 days" product requirement. Each set is 12 phrases, matching
// BATCH_SIZE -- buildFallbackBatch's slice(0, BATCH_SIZE) would otherwise
// silently cap below BATCH_SIZE if a set were shorter.
const FALLBACK_PHRASES = {
  en: [
    [
      'Kindness nearby is looking for you today',
      'You already did something good today',
      'Rest is normal, not something earned',
      'Someone today is genuinely glad you exist',
      'Caring for yourself counts as a small win',
      'Your pace today is still the right pace',
      'Good things often arrive without warning',
      'Today, simply existing is already enough',
      'A short pause protects more than it seems',
      'Someone noticed and appreciated what you did',
      'A kind word outlasts a whole day',
      'You deserve gentleness toward yourself today',
    ],
    [
      'One calm hour can change a whole day',
      'You can be proud without needing a reason',
      'Your effort today already means something',
      'Good people are more common than they seem',
      'A small joy is still a real joy',
      'Tiredness doesn\'t erase what you accomplished',
      'Someone will remember your kindness for a while',
      'Today hasn\'t said its last word yet',
      'A slow morning still counts as complete',
      'Your path doesn\'t have to be fast',
      'Getting through today calmly is enough sometimes',
      'Care can start small, and that\'s fine',
    ],
    [
      'One kind word outweighs a hard day',
      'A small step forward is still a step',
      'Today already holds something good in it',
      'Pride doesn\'t need anyone\'s permission',
      'Laughter also counts as real progress',
      'Someone is grateful you\'re around',
      'Good moments rarely announce themselves early',
      'One deep breath can change a lot',
      'You deserve patience, especially your own',
      'Not every day needs a big reason',
      'Small joys add up to something bigger',
      'Your kindness returns, even unnoticed',
    ],
    [
      'Five calm minutes still count as self-care',
      'You\'re allowed to be quietly proud',
      'Something good may be closer than it seems',
      'Kindness toward yourself isn\'t weakness',
      'One good hour can shift a whole day',
      'People remember warmth more than perfection',
      'Today\'s effort matters without an audience',
      'Small progress is still real progress',
      'A calm pace still leads somewhere good',
      'Rest doesn\'t need to be earned first',
      'Someone\'s glad you\'re part of their day',
      'Your care for others rarely goes unnoticed',
    ],
    [
      'Sometimes a good mood is simply enough',
      'Your kindness matters, even without words',
      'One calm moment is worth a lot',
      'Today, you\'re allowed to be gentler with yourself',
      'A little warmth can change someone\'s day',
      'Good days don\'t have to be loud',
      'Caring for yourself takes quiet courage too',
      'Someone today is thankful specifically for you',
      'Your day can still turn around',
      'Not all good things need noticing right away',
      'Being kind to yourself is a real strength',
      'Warm words tend to outlast the moment',
    ],
  ],
  fr: [
    [
      'Une gentillesse t\'attend peut-être aujourd\'hui',
      'Tu as déjà fait quelque chose de bien',
      'Le repos est normal, pas à mériter',
      'Quelqu\'un aujourd\'hui est sincèrement content que tu existes',
      'Prendre soin de toi compte comme une victoire',
      'Ton rythme d\'aujourd\'hui est le bon',
      'Les bonnes choses arrivent souvent sans prévenir',
      'Aujourd\'hui, exister suffit déjà',
      'Une courte pause protège plus qu\'il n\'y paraît',
      'Quelqu\'un a remarqué ce que tu as fait',
      'Un mot gentil dure plus qu\'une journée',
      'Tu mérites de la douceur envers toi-même',
    ],
    [
      'Une heure calme peut changer toute la journée',
      'La fierté n\'a besoin d\'aucune raison',
      'Ton effort d\'aujourd\'hui compte déjà',
      'Les gens gentils sont partout, discrètement',
      'Une petite joie reste une vraie joie',
      'La fatigue n\'efface pas tes efforts',
      'Quelqu\'un se souviendra de ta gentillesse',
      'La journée n\'a pas dit son dernier mot',
      'Un matin lent reste un vrai matin',
      'Ton chemin n\'a pas besoin d\'être rapide',
      'Traverser la journée calmement suffit parfois',
      'Le soin peut commencer petit, et c\'est bien',
    ],
    [
      'Un mot gentil pèse plus qu\'une journée difficile',
      'Un petit pas reste un vrai pas',
      'Aujourd\'hui contient déjà quelque chose de bon',
      'La fierté n\'a besoin de permission de personne',
      'Rire compte aussi comme un vrai progrès',
      'Quelqu\'un est reconnaissant que tu sois là',
      'Les bons moments arrivent rarement en prévenant',
      'Une grande respiration peut changer beaucoup de choses',
      'Tu mérites de la patience, surtout la tienne',
      'Chaque jour n\'a pas besoin d\'une grande raison',
      'Les petites joies finissent par compter beaucoup',
      'Ta gentillesse revient, même sans que tu voies',
    ],
    [
      'Cinq minutes calmes comptent aussi comme un soin',
      'Tu as le droit d\'être fier en silence',
      'Une bonne chose est peut-être toute proche',
      'La douceur envers toi-même n\'est pas une faiblesse',
      'Une bonne heure peut changer toute la journée',
      'On retient la chaleur, pas la perfection',
      'L\'effort d\'aujourd\'hui compte sans public',
      'Un petit progrès reste un vrai progrès',
      'Un rythme calme mène aussi loin',
      'Le repos n\'a pas besoin d\'être mérité d\'abord',
      'Quelqu\'un est content que tu sois là',
      'Ton attention envers les autres ne passe pas',
    ],
    [
      'Parfois, une bonne humeur suffit amplement',
      'Ta gentillesse compte, même sans un mot',
      'Un moment calme vaut déjà beaucoup',
      'Aujourd\'hui, tu peux être plus doux avec toi-même',
      'Un peu de chaleur peut changer une journée',
      'Les bons jours n\'ont pas besoin d\'être bruyants',
      'Prendre soin de soi demande aussi du courage',
      'Quelqu\'un aujourd\'hui te remercie particulièrement',
      'Ta journée peut encore s\'améliorer',
      'Tout bon n\'a pas besoin d\'être vu vite',
      'Être doux avec toi-même est une vraie force',
      'Les mots chaleureux durent plus longtemps qu\'un instant',
    ],
  ],
  es: [
    [
      'Hoy alguien amable podría estar cerca de ti',
      'Hoy ya hiciste algo bueno',
      'Descansar es normal, no algo que ganar',
      'Alguien hoy se alegra de que existas',
      'Cuidarte también cuenta como un pequeño logro',
      'Tu ritmo de hoy también es el correcto',
      'Las cosas buenas suelen llegar sin avisar',
      'Hoy, simplemente existir ya es suficiente',
      'Una pausa corta protege más de lo esperado',
      'Alguien notó y valoró lo que hiciste',
      'Una palabra amable dura más que un día',
      'Mereces un poco de suavidad contigo mismo hoy',
    ],
    [
      'Una hora tranquila puede cambiar todo el día',
      'Puedes sentirte orgulloso sin necesitar un motivo',
      'Tu esfuerzo de hoy ya significa algo',
      'La gente buena abunda más de lo esperado',
      'Una pequeña alegría sigue siendo una alegría real',
      'El cansancio no borra lo que lograste',
      'Alguien recordará tu amabilidad por un tiempo',
      'El día aún no dijo su última palabra',
      'Una mañana lenta también es una mañana completa',
      'Tu camino no tiene que ser rápido',
      'A veces basta con pasar el día tranquilo',
      'El cuidado puede empezar pequeño, y está bien',
    ],
    [
      'Una palabra amable supera un día difícil',
      'Un pequeño paso sigue siendo un paso',
      'Hoy ya guarda algo bueno dentro',
      'El orgullo no necesita permiso de nadie',
      'Reír también cuenta como verdadero progreso',
      'Alguien agradece que estés cerca',
      'Los buenos momentos rara vez avisan antes',
      'Una respiración profunda puede cambiar mucho',
      'Mereces paciencia, sobre todo la tuya',
      'No todos los días necesitan un gran motivo',
      'Las pequeñas alegrías suman algo más grande',
      'Tu amabilidad vuelve, aunque no se note',
    ],
    [
      'Cinco minutos tranquilos también son cuidado propio',
      'Puedes estar orgulloso en silencio',
      'Algo bueno puede estar cerca de ti',
      'Ser amable contigo mismo no es debilidad',
      'Una buena hora puede cambiar todo el día',
      'La gente recuerda la calidez, no la perfección',
      'El esfuerzo de hoy importa sin público',
      'Un pequeño avance sigue siendo un avance real',
      'Un ritmo tranquilo también llega lejos',
      'El descanso no necesita ganarse primero',
      'Alguien se alegra de que estés hoy',
      'Tu cuidado por otros rara vez pasa desapercibido',
    ],
    [
      'A veces un buen humor ya es suficiente',
      'Tu amabilidad importa, incluso sin palabras',
      'Un momento tranquilo ya vale mucho',
      'Hoy puedes ser más suave contigo mismo',
      'Un poco de calidez puede cambiar un día',
      'Los buenos días no necesitan ser ruidosos',
      'Cuidarte también requiere un poco de valor',
      'Alguien hoy está agradecido especialmente contigo',
      'Tu día todavía puede mejorar',
      'No todo lo bueno necesita notarse de inmediato',
      'Ser amable contigo mismo es una fortaleza real',
      'Las palabras cálidas duran más que el momento',
    ],
  ],
  pt: [
    [
      'Alguém gentil pode estar por perto hoje',
      'Você já fez algo bom hoje',
      'Descansar é normal, não algo a merecer',
      'Alguém hoje está feliz por você existir',
      'Cuidar de si também conta como uma vitória',
      'Seu ritmo de hoje também está certo',
      'Coisas boas costumam chegar sem avisar',
      'Hoje, simplesmente existir já é suficiente',
      'Uma pausa curta protege mais do que parece',
      'Alguém notou e valorizou o que você fez',
      'Uma palavra gentil dura mais que um dia',
      'Você merece um pouco de gentileza consigo hoje',
    ],
    [
      'Uma hora calma pode mudar o dia inteiro',
      'Você pode se orgulhar sem precisar de motivo',
      'Seu esforço de hoje já significa algo',
      'Pessoas boas são mais comuns do que parecem',
      'Uma pequena alegria ainda é uma alegria real',
      'O cansaço não apaga o que você fez',
      'Alguém vai lembrar da sua gentileza',
      'O dia ainda não disse a última palavra',
      'Uma manhã lenta também conta como manhã completa',
      'Seu caminho não precisa ser rápido',
      'Às vezes basta atravessar o dia com calma',
      'O cuidado pode começar pequeno, e tudo bem',
    ],
    [
      'Uma palavra gentil supera um dia difícil',
      'Um pequeno passo ainda é um passo',
      'Hoje já guarda algo bom dentro dele',
      'O orgulho não precisa de permissão de ninguém',
      'Rir também conta como progresso real',
      'Alguém é grato por você estar por perto',
      'Bons momentos raramente avisam antes',
      'Uma respiração profunda pode mudar muita coisa',
      'Você merece paciência, especialmente a sua',
      'Nem todo dia precisa de um grande motivo',
      'Pequenas alegrias somam algo maior',
      'Sua gentileza volta, mesmo sem perceber',
    ],
    [
      'Cinco minutos calmos também são autocuidado',
      'Você pode se orgulhar em silêncio',
      'Algo bom pode estar bem perto de você',
      'Ser gentil consigo mesmo não é fraqueza',
      'Uma boa hora pode mudar o dia inteiro',
      'As pessoas lembram do calor, não da perfeição',
      'O esforço de hoje importa sem plateia',
      'Um pequeno progresso ainda é progresso real',
      'Um ritmo calmo também chega longe',
      'O descanso não precisa ser merecido antes',
      'Alguém está feliz por você estar aqui hoje',
      'Seu cuidado com os outros raramente passa despercebido',
    ],
    [
      'Às vezes um bom humor já é suficiente',
      'Sua gentileza importa, mesmo sem palavras',
      'Um momento calmo já vale muito',
      'Hoje você pode ser mais gentil consigo mesmo',
      'Um pouco de calor pode mudar um dia',
      'Bons dias não precisam ser barulhentos',
      'Cuidar de si também exige uma coragem quieta',
      'Alguém hoje é grato especialmente a você',
      'Seu dia ainda pode melhorar',
      'Nem tudo de bom precisa ser notado logo',
      'Ser gentil consigo mesmo é uma força real',
      'Palavras calorosas duram mais que o momento',
    ],
  ],
  de: [
    [
      'Vielleicht sucht heute jemand Freundliches nach dir',
      'Du hast heute schon etwas Gutes getan',
      'Ruhe ist normal, nichts, das man verdienen muss',
      'Jemand freut sich einfach, dass es dich gibt',
      'Auf dich zu achten zählt als kleiner Erfolg',
      'Dein heutiges Tempo ist auch das richtige',
      'Gute Dinge kommen oft ohne Vorwarnung',
      'Heute reicht es schon, einfach da zu sein',
      'Eine kurze Pause schützt mehr, als sie scheint',
      'Jemand hat bemerkt, was du getan hast',
      'Ein freundliches Wort überdauert einen ganzen Tag',
      'Du verdienst heute etwas Milde dir selbst gegenüber',
    ],
    [
      'Eine ruhige Stunde kann den ganzen Tag verändern',
      'Stolz zu sein braucht keinen besonderen Grund',
      'Deine heutige Mühe bedeutet schon etwas',
      'Gute Menschen sind häufiger, als es scheint',
      'Eine kleine Freude bleibt eine echte Freude',
      'Müdigkeit löscht nicht, was du geschafft hast',
      'Jemand wird sich an deine Freundlichkeit erinnern',
      'Der heutige Tag ist noch nicht vorbei',
      'Ein langsamer Morgen zählt auch als voller Morgen',
      'Dein Weg muss nicht schnell sein',
      'Manchmal reicht es, den Tag ruhig zu überstehen',
      'Fürsorge darf klein anfangen, das ist in Ordnung',
    ],
    [
      'Ein freundliches Wort wiegt einen schweren Tag auf',
      'Ein kleiner Schritt bleibt trotzdem ein Schritt',
      'Der heutige Tag trägt schon etwas Gutes',
      'Stolz braucht die Erlaubnis von niemandem',
      'Lachen zählt ebenfalls als echter Fortschritt',
      'Jemand ist dankbar, dass du da bist',
      'Gute Momente kündigen sich selten an',
      'Ein tiefer Atemzug kann viel verändern',
      'Du verdienst Geduld, besonders deine eigene',
      'Nicht jeder Tag braucht einen großen Grund',
      'Kleine Freuden summieren sich zu etwas Größerem',
      'Deine Freundlichkeit kehrt zurück, auch unbemerkt',
    ],
    [
      'Fünf ruhige Minuten zählen auch als Selbstfürsorge',
      'Du darfst still auf dich stolz sein',
      'Etwas Gutes ist vielleicht näher, als es scheint',
      'Milde dir selbst gegenüber ist keine Schwäche',
      'Eine gute Stunde kann den ganzen Tag verändern',
      'Menschen erinnern sich an Wärme, nicht an Perfektion',
      'Die heutige Mühe zählt auch ohne Publikum',
      'Kleiner Fortschritt bleibt echter Fortschritt',
      'Ein ruhiges Tempo führt trotzdem weit',
      'Ruhe muss man sich nicht erst verdienen',
      'Jemand freut sich, dass du heute da bist',
      'Deine Fürsorge für andere bleibt selten unbemerkt',
    ],
    [
      'Manchmal reicht einfach gute Laune schon aus',
      'Deine Freundlichkeit zählt, auch ohne Worte',
      'Ein ruhiger Moment ist schon viel wert',
      'Heute darfst du milder mit dir selbst sein',
      'Etwas Wärme kann jemandes Tag verändern',
      'Gute Tage müssen nicht laut sein',
      'Auf sich selbst zu achten braucht auch Mut',
      'Jemand ist heute besonders dankbar für dich',
      'Dein Tag kann sich noch zum Guten wenden',
      'Nicht alles Gute muss sofort bemerkt werden',
      'Freundlich zu dir selbst zu sein ist Stärke',
      'Warme Worte bleiben länger als der Moment',
    ],
  ],
  ru: [
    [
      'Доброта где-то рядом ищет тебя',
      'Ты уже сделал сегодня немало хорошего',
      'Отдых — это норма, а не награда',
      'Кто-то сегодня искренне рад тебе',
      'Забота о себе — тоже маленькая победа',
      'Твой сегодняшний темп тоже правильный',
      'Хорошее часто приходит без предупреждения',
      'Сегодня достаточно того, что ты есть',
      'Простая пауза бережёт больше, чем кажется',
      'Кто-то ценит то, что ты сделал',
      'Доброе слово живёт дольше целого дня',
      'Ты заслуживаешь мягкости к себе',
    ],
    [
      'Один тихий час меняет весь день',
      'Гордиться собой можно и без повода',
      'Твои усилия сегодня уже что-то значат',
      'Хорошие люди встречаются чаще, чем кажется',
      'Маленькая радость тоже настоящая радость',
      'Усталость не стирает то, что ты сделал',
      'Кто-то запомнил твою доброту надолго',
      'У сегодняшнего дня ещё есть шанс порадовать',
      'Медленное утро — тоже полноценное утро',
      'Твой путь не обязан быть быстрым',
      'Иногда достаточно просто мирно пережить день',
      'Забота начинается с малого, и это нормально',
    ],
    [
      'Одно доброе слово перевешивает трудный день',
      'Маленький шаг вперёд — всё равно шаг',
      'В сегодняшнем дне уже есть что-то хорошее',
      'Гордость не требует разрешения со стороны',
      'Смех тоже похож на настоящий прогресс',
      'Кто-то благодарен за то, что ты рядом',
      'Хорошие моменты редко предупреждают заранее',
      'Один глубокий вдох меняет многое',
      'Ты заслуживаешь терпения, особенно своего',
      'Не каждому дню нужен весомый повод',
      'Мелкие радости складываются в нечто большее',
      'Твоя доброта возвращается, даже если незаметно',
    ],
    [
      'Пять тихих минут тоже забота о себе',
      'Гордиться собой можно и тихо',
      'Хорошее часто ближе, чем кажется',
      'Доброта к себе — не слабость',
      'Один хороший час меняет весь день',
      'Люди запоминают тепло, а не идеальность',
      'Сегодняшние усилия важны без зрителей',
      'Маленький прогресс всё равно прогресс',
      'Ровный темп тоже приводит к цели',
      'Отдых не нужно заслуживать заранее',
      'Кто-то рад, что ты часть его дня',
      'Твоя забота о других не проходит бесследно',
    ],
    [
      'Иногда достаточно просто хорошего настроения',
      'Твоя доброта важна, даже без слов',
      'Один тихий момент стоит многого',
      'Сегодня можно быть добрее к себе',
      'Маленькое тепло меняет чужой день',
      'Хорошие дни не обязаны быть громкими',
      'Забота о себе тоже требует смелости',
      'Кто-то сегодня благодарен именно тебе',
      'Твой день ещё может измениться к лучшему',
      'Не всё хорошее нужно замечать сразу',
      'Доброе отношение к себе — тоже сила',
      'Тёплые слова остаются дольше, чем кажется',
    ],
  ],
  zh: [
    [
      '今天也许有人正温柔地想着你',
      '你今天已经做了一件好事',
      '休息是正常的，不是要靠努力换来的',
      '今天有人真心为你的存在感到高兴',
      '好好照顾自己也算一种小小的胜利',
      '你今天的节奏本身就是对的',
      '好事常常悄悄地到来',
      '今天只要存在着就已经足够',
      '短暂的停顿其实很有保护作用',
      '有人注意到并感激你做的事',
      '一句好话能温暖很久',
      '今天可以对自己温柔一点',
    ],
    [
      '一个安静的小时能改变一整天',
      '为自己骄傲不需要理由',
      '你今天的努力已经有意义',
      '善良的人其实比想象中更多',
      '小小的快乐也是真实的快乐',
      '疲惫不会抹去你已经做到的事',
      '有人会记得你的善意很久',
      '这一天还没说出最后的话',
      '缓慢的早晨也算完整的早晨',
      '你的路不必走得很快',
      '有时平静地度过一天就够了',
      '关心可以从很小的地方开始',
    ],
    [
      '一句好话能抵过艰难的一天',
      '小小的一步依然是一步',
      '今天已经藏着一点好事',
      '骄傲不需要任何人的许可',
      '笑一笑也算真正的进步',
      '有人很感激你就在身边',
      '好的时刻很少提前打招呼',
      '一次深呼吸能改变很多',
      '你值得被耐心对待，尤其是被自己',
      '不是每一天都需要重大的理由',
      '小小的快乐会累积成很大的事',
      '你的善意会回来，只是不易察觉',
    ],
    [
      '安静五分钟也是一种自我照顾',
      '你可以悄悄地为自己骄傲',
      '好事也许比想象中更近',
      '善待自己不是软弱',
      '一个好的小时能改变一整天',
      '人们记得的是温暖，而不是完美',
      '今天的努力不需要观众也很重要',
      '一点点进步依然是真正的进步',
      '平稳的节奏也能走得很远',
      '休息不需要提前挣得',
      '有人为你成为他今天的一部分而高兴',
      '你对别人的关心很少被忽略',
    ],
    [
      '有时候好心情就已经足够',
      '你的善意很重要，即使没有说出口',
      '一个安静的时刻已经很珍贵',
      '今天可以对自己更温柔一些',
      '一点温暖能改变别人的一天',
      '好的日子不需要很喧闹',
      '照顾自己也需要一点安静的勇气',
      '今天有人特别感激你',
      '你的一天还有机会变好',
      '不是所有好事都要立刻被看见',
      '善待自己是一种真正的力量',
      '温暖的话比那一刻停留得更久',
    ],
  ],
  ja: [
    [
      '今日、誰かが静かにあなたを思っています',
      '今日もう何かいいことをしましたね',
      '休むことは当たり前で、稼ぐものではありません',
      '今日、誰かがあなたの存在を心から喜んでいます',
      '自分を大切にすることも小さな成功です',
      '今日のペースもきっと正しいペースです',
      '良いことは前触れなく訪れることが多いです',
      '今日は存在しているだけで十分です',
      '短い休憩は思う以上に大切です',
      '誰かがあなたの行動に気づいて感謝しています',
      '優しい言葉は一日より長く残ります',
      '今日は自分に少し優しくしていいのです',
    ],
    [
      '静かな一時間が一日を変えることがあります',
      '誇りを持つのに理由はいりません',
      '今日の頑張りにはすでに意味があります',
      '優しい人は思うより多いものです',
      '小さな喜びも本物の喜びです',
      '疲れは今日の成果を消しません',
      '誰かがあなたの優しさを覚えています',
      '今日はまだ終わっていません',
      'ゆっくりした朝も立派な朝です',
      'あなたの歩みは急がなくていいのです',
      '穏やかに一日を過ごせれば十分な日もあります',
      '思いやりは小さく始めてもいいのです',
    ],
    [
      '優しい一言は辛い一日より重いです',
      '小さな一歩もやはり一歩です',
      '今日にはすでに良いことが隠れています',
      '誇りに誰かの許可はいりません',
      '笑うことも立派な前進です',
      '誰かがあなたのそばにいることに感謝しています',
      '良い瞬間は前触れなく訪れます',
      '深呼吸ひとつが多くを変えます',
      'あなたは自分自身への忍耐にも値します',
      'すべての日に大きな理由は必要ありません',
      '小さな喜びは積み重なって大きくなります',
      'あなたの優しさは気づかれなくても戻ってきます',
    ],
    [
      '静かな五分間も立派なセルフケアです',
      '静かに自分を誇りに思っていいのです',
      '良いことは思うより近くにあるかもしれません',
      '自分への優しさは弱さではありません',
      '良い一時間が一日全体を変えることもあります',
      '人は完璧さより温かさを覚えています',
      '今日の努力は見られなくても大切です',
      '小さな前進もやはり本物の前進です',
      '穏やかなペースでも遠くまで行けます',
      '休息は先に稼ぐ必要はありません',
      '誰かがあなたと一日を共にできて喜んでいます',
      'あなたの思いやりは見過ごされにくいものです',
    ],
    [
      '時には良い気分だけで十分です',
      'あなたの優しさは言葉がなくても伝わります',
      '静かな一瞬にもすでに価値があります',
      '今日は自分にもう少し優しくしていいのです',
      '少しの温かさが誰かの一日を変えます',
      '良い日は賑やかである必要はありません',
      '自分を大切にするにも静かな勇気が要ります',
      '今日、誰かが特にあなたに感謝しています',
      'あなたの一日はまだ良い方向に進めます',
      '良いことすべてをすぐ気づく必要はありません',
      '自分に優しくすることは本当の強さです',
      '温かい言葉はその瞬間より長く残ります',
    ],
  ],
  ko: [
    [
      '오늘 누군가 조용히 당신을 생각하고 있어요',
      '오늘도 이미 좋은 일을 하나 해냈어요',
      '휴식은 당연한 것이지 따로 얻어내는 게 아니에요',
      '오늘 누군가는 당신이 있어서 진심으로 기뻐해요',
      '자신을 돌보는 것도 작은 성취예요',
      '오늘의 속도도 충분히 옳은 속도예요',
      '좋은 일은 예고 없이 찾아오곤 해요',
      '오늘은 존재하는 것만으로도 충분해요',
      '짧은 쉼도 생각보다 큰 도움이 돼요',
      '누군가 당신이 한 일을 알아채고 고마워해요',
      '따뜻한 말 한마디는 하루보다 오래 남아요',
      '오늘은 스스로에게 조금 부드러워도 괜찮아요',
    ],
    [
      '조용한 한 시간이 하루를 바꾸기도 해요',
      '자랑스러움에는 특별한 이유가 필요 없어요',
      '오늘의 노력은 이미 의미가 있어요',
      '좋은 사람은 생각보다 흔해요',
      '작은 기쁨도 분명 진짜 기쁨이에요',
      '피곤함이 당신이 해낸 일을 지우진 않아요',
      '누군가 당신의 친절을 오래 기억할 거예요',
      '오늘은 아직 끝나지 않았어요',
      '느린 아침도 온전한 아침이에요',
      '당신의 걸음은 빠를 필요 없어요',
      '가끔은 하루를 차분히 보내는 것만으로도 충분해요',
      '돌봄은 작은 것에서 시작해도 괜찮아요',
    ],
    [
      '따뜻한 말 한마디가 힘든 하루보다 무거워요',
      '작은 한 걸음도 분명한 걸음이에요',
      '오늘 안에는 이미 좋은 것이 숨어 있어요',
      '자부심에는 누구의 허락도 필요 없어요',
      '웃음도 진짜 성장으로 쳐줘요',
      '누군가 당신이 곁에 있어 고마워해요',
      '좋은 순간은 예고 없이 찾아오곤 해요',
      '깊은 숨 한 번이 많은 걸 바꿔요',
      '당신은 인내를, 특히 스스로의 인내를 받을 자격이 있어요',
      '모든 날이 큰 이유를 필요로 하진 않아요',
      '작은 기쁨들이 모여 큰 것이 돼요',
      '당신의 친절은 몰라도 결국 돌아와요',
    ],
    [
      '조용한 오 분도 자기 돌봄이에요',
      '조용히 스스로를 자랑스러워해도 괜찮아요',
      '좋은 일은 생각보다 가까이 있을지도 몰라요',
      '자신에게 다정한 건 약함이 아니에요',
      '좋은 한 시간이 하루 전체를 바꾸기도 해요',
      '사람들은 완벽함보다 따뜻함을 기억해요',
      '오늘의 노력은 지켜보는 사람이 없어도 소중해요',
      '작은 발전도 진짜 발전이에요',
      '차분한 속도로도 멀리 갈 수 있어요',
      '휴식은 미리 얻어낼 필요가 없어요',
      '누군가 당신과 하루를 함께해서 기뻐해요',
      '다른 사람을 향한 당신의 배려는 잘 잊히지 않아요',
    ],
    [
      '가끔은 좋은 기분만으로도 충분해요',
      '당신의 친절은 말이 없어도 전해져요',
      '조용한 한순간도 이미 큰 가치가 있어요',
      '오늘은 스스로에게 조금 더 다정해도 괜찮아요',
      '작은 따뜻함이 누군가의 하루를 바꿔요',
      '좋은 날이 꼭 시끄러울 필요는 없어요',
      '자신을 돌보는 데도 조용한 용기가 필요해요',
      '오늘 누군가는 특별히 당신에게 고마워해요',
      '당신의 하루는 아직 더 좋아질 수 있어요',
      '좋은 일 모두를 바로 알아챌 필요는 없어요',
      '스스로에게 다정한 것은 진짜 강함이에요',
      '따뜻한 말은 그 순간보다 오래 남아요',
    ],
  ],
  it: [
    [
      'Qualcuno gentile potrebbe essere vicino oggi',
      'Hai già fatto qualcosa di buono oggi',
      'Riposare è normale, non qualcosa da meritare',
      'Qualcuno oggi è sinceramente felice che tu esista',
      'Prendersi cura di sé è già una vittoria',
      'Il tuo ritmo di oggi è quello giusto',
      'Le cose belle spesso arrivano senza avviso',
      'Oggi, semplicemente esistere è già abbastanza',
      'Una breve pausa protegge più di quanto sembri',
      'Qualcuno ha notato e apprezzato il tuo gesto',
      'Una parola gentile dura più di un giorno',
      'Meriti un po\' di gentilezza verso te stesso',
    ],
    [
      'Un\'ora tranquilla può cambiare l\'intera giornata',
      'Essere orgogliosi non richiede un motivo',
      'Il tuo impegno di oggi conta già qualcosa',
      'Le persone gentili sono più comuni del previsto',
      'Una piccola gioia resta una gioia vera',
      'La stanchezza non cancella ciò che hai fatto',
      'Qualcuno ricorderà la tua gentilezza a lungo',
      'La giornata non ha ancora detto l\'ultima parola',
      'Una mattina lenta conta comunque come intera',
      'Il tuo percorso non deve essere veloce',
      'A volte basta attraversare la giornata con calma',
      'La cura può iniziare piccola, ed è giusto',
    ],
    [
      'Una parola gentile supera un giorno difficile',
      'Un piccolo passo resta comunque un passo',
      'Oggi contiene già qualcosa di buono',
      'L\'orgoglio non ha bisogno del permesso di nessuno',
      'Ridere conta anche come vero progresso',
      'Qualcuno è grato che tu sia vicino',
      'I bei momenti raramente avvisano prima',
      'Un respiro profondo può cambiare molto',
      'Meriti pazienza, soprattutto la tua',
      'Non ogni giorno serve un grande motivo',
      'Le piccole gioie diventano qualcosa di più grande',
      'La tua gentilezza ritorna, anche se invisibile',
    ],
    [
      'Cinque minuti tranquilli contano come cura di sé',
      'Puoi essere orgoglioso anche in silenzio',
      'Qualcosa di buono è forse più vicino',
      'Essere gentili con se stessi non è debolezza',
      'Una buona ora può cambiare l\'intera giornata',
      'Le persone ricordano il calore, non la perfezione',
      'L\'impegno di oggi conta anche senza pubblico',
      'Un piccolo progresso resta un progresso vero',
      'Un ritmo calmo porta comunque lontano',
      'Il riposo non va meritato prima',
      'Qualcuno è felice che tu sia qui oggi',
      'La tua cura per gli altri conta davvero',
    ],
    [
      'A volte un buon umore già basta',
      'La tua gentilezza conta, anche senza parole',
      'Un momento tranquillo vale già molto',
      'Oggi puoi essere più dolce con te stesso',
      'Un po\' di calore può cambiare una giornata',
      'I bei giorni non devono essere rumorosi',
      'Prendersi cura di sé richiede anche coraggio silenzioso',
      'Qualcuno oggi è grato proprio a te',
      'La tua giornata può ancora migliorare',
      'Non tutto il bello va notato subito',
      'Essere gentili con se stessi è vera forza',
      'Le parole calde durano più del momento',
    ],
  ],
};

// Which of FALLBACK_PHRASES[lang]'s 5 sets is "today's" set -- calendar day
// (UTC, not device-local: this is a shared, non-personalized safety net, not
// user-facing "today" framing the way now.date already is) modulo 5, so a
// real outage rotates through all 5 sets across 5 consecutive days rather
// than repeating day 1's set until the outage ends. Deterministic, no DB
// state: every request on the same UTC calendar day gets the same set, and
// the set changes at UTC midnight.
const FALLBACK_SET_COUNT = 5;
function currentFallbackSetIndex(now = new Date()) {
  const epochDay = Math.floor(now.getTime() / 86400000);
  return ((epochDay % FALLBACK_SET_COUNT) + FALLBACK_SET_COUNT) % FALLBACK_SET_COUNT;
}

// Resolves language (with the same DEFAULT_LANGUAGE_CODE fallback every
// caller already used) AND today's rotating set in one place, so all 4
// FALLBACK_PHRASES call sites (buildFallbackBatch, assembleByExpectedSlotOrder,
// fillWithFallbackPhrases, pickRandomFallbackPhrase) stay in sync on which
// set is "current" -- they must never disagree mid-request.
function activeFallbackPhrases(languageCode) {
  const sets = FALLBACK_PHRASES[languageCode] || FALLBACK_PHRASES[DEFAULT_LANGUAGE_CODE];
  return sets[currentFallbackSetIndex()];
}

// The 10 languages product/DoD calls for (locale-driven generation task).
// Each entry names the language for the SYSTEM_PROMPT and a scriptCheck
// regex used to catch full-phrase language drift (see isValidLanguageText
// below) — not a translation-quality check, just "does this phrase contain
// at least one character from the script this language is expected to use".
// Latin-script languages (en/fr/es/pt/de/it) share one scriptCheck: this
// mirrors the previous English-only heuristic, which could only ever tell
// "Latin vs. not-Latin" apart too — distinguishing e.g. French from Italian
// text is not attempted, same scope boundary as before.
const SUPPORTED_LANGUAGES = {
  en: { name: 'English', scriptCheck: /\p{Script=Latin}/u },
  fr: { name: 'French', scriptCheck: /\p{Script=Latin}/u },
  es: { name: 'Spanish', scriptCheck: /\p{Script=Latin}/u },
  pt: { name: 'Portuguese', scriptCheck: /\p{Script=Latin}/u },
  de: { name: 'German', scriptCheck: /\p{Script=Latin}/u },
  ru: { name: 'Russian', scriptCheck: /\p{Script=Cyrillic}/u },
  zh: { name: 'Chinese', scriptCheck: /\p{Script=Han}/u },
  ja: { name: 'Japanese', scriptCheck: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u },
  ko: { name: 'Korean', scriptCheck: /\p{Script=Hangul}/u },
  it: { name: 'Italian', scriptCheck: /\p{Script=Latin}/u },
};
const DEFAULT_LANGUAGE_CODE = 'en';

// Resolves the target generation language from the client's system_language
// signal (see deviceSignals.js — already an ISO 639-1 code like "ru", "zh",
// validated there against /^[A-Za-z-]+$/). Anything missing or not in
// SUPPORTED_LANGUAGES falls back to English, per DoD point 2 — this covers
// both "client didn't send the signal" (older app version) and "client sent
// a real language we don't support yet" (e.g. Arabic) the same way.
function resolveTargetLanguageCode(signals) {
  const raw = signals && typeof signals.system_language === 'string'
    ? signals.system_language.toLowerCase()
    : null;
  return raw && SUPPORTED_LANGUAGES[raw] ? raw : DEFAULT_LANGUAGE_CODE;
}

function pickRandomStyle() {
  return STYLE_IDS[Math.floor(Math.random() * STYLE_IDS.length)];
}

// Returns `count` distinct style_ids (Fisher-Yates shuffle of the full 27-value
// STYLE_IDS, then take the first `count`) -- used wherever a batch needs several
// different backgrounds guaranteed with no repeats, e.g. buildFallbackBatch below.
// count must not exceed STYLE_IDS.length (27); BATCH_SIZE (12) leaves comfortable
// headroom.
function pickUniqueStyles(count) {
  const shuffled = [...STYLE_IDS];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count);
}

function pickFirstUnusedStyle(usedStyles) {
  return STYLE_IDS.find((id) => !usedStyles.has(id)) || pickRandomStyle();
}

// Reassigns any duplicate style_id within a batch to one not yet used in that
// same batch, walked in order -- keeps each phrase's own style_id whenever it's
// still free within the batch, only touches actual repeats. 27 style_ids vs
// BATCH_SIZE (12) leaves comfortable headroom, so an unused one is always
// available. This is the hard guarantee; buildSystemPrompt's "don't repeat
// style_id" instruction above is only a soft ask to the model, not relied on
// alone.
function dedupeStyleIds(items) {
  const used = new Set();
  return items.map((item) => {
    if (!used.has(item.style_id)) {
      used.add(item.style_id);
      return item;
    }
    const available = STYLE_IDS.filter((id) => !used.has(id));
    const replacement = available[Math.floor(Math.random() * available.length)];
    used.add(replacement);
    return { ...item, style_id: replacement };
  });
}

function normalizeTextForDedupe(text) {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

function hasQuestionShapeWithoutMark(text) {
  const normalized = normalizeTextForDedupe(text).replace(/[.!…,:;]+$/g, '');
  return /^(знаешь ли|а ты|ты замечал|ты когда-нибудь|хочешь|почему бы не|как насч[её]т)(?:\s|$|[,.!…:;])/i.test(normalized);
}

function isGenericBadLockScreenPhrase(text) {
  const normalized = normalizeTextForDedupe(text).replace(/[.!…,:;]+$/g, '');
  return [
    'скорее всего, есть одна вещь, с которой стоит начать',
    'маленькие улучшения тоже меняют форму',
    'маленькое улучшение тоже меняет форму',
    'на дне есть место для более точного угла',
    'в дне есть место для более точного угла',
    'следующему действию не нужна церемония',
    'чистый старт подходит любому дню',
    'заметь ту часть, которая уже работает',
  ].includes(normalized);
}

function isUnusableLockScreenText(text) {
  const filterResult = validateLockScreenText(text, { maxLength: LOCK_SCREEN_TEXT_MAX_LENGTH });
  return (
    !filterResult.ok ||
    hasQuestionShapeWithoutMark(text) ||
    isGenericBadLockScreenPhrase(text)
  );
}

function getLanguageMap(map, languageCode) {
  return map[languageCode] || map[DEFAULT_LANGUAGE_CODE] || {};
}

function containsAnyMarker(normalized, markers) {
  return markers.some((marker) => normalized.includes(marker));
}

function detectRelativeWeekdayClaim(text, languageCode) {
  const normalized = normalizeTextForDedupe(text);
  const relativeMarkers = getLanguageMap(RELATIVE_DAY_MARKERS, languageCode);
  const weekdayAliases = getLanguageMap(WEEKDAY_ALIASES, languageCode);
  const relative = Object.keys(relativeMarkers).find((key) => containsAnyMarker(normalized, relativeMarkers[key]));
  if (!relative) {
    return null;
  }
  for (const [weekday, aliases] of Object.entries(weekdayAliases)) {
    if (containsAnyMarker(normalized, aliases)) {
      return { relative, weekday };
    }
  }
  return null;
}

function hasInvalidRelativeDateClaim(text, languageCode, validationContext = {}) {
  const claim = detectRelativeWeekdayClaim(text, languageCode);
  if (!claim) {
    return false;
  }
  const dateContext = validationContext.dateContext;
  if (!dateContext) {
    return true;
  }
  const expected = claim.relative === 'tomorrow'
    ? dateContext.tomorrow_weekday
    : dateContext.weekday;
  return expected !== claim.weekday;
}

function numberNearTerms(normalized, value, terms) {
  if (value === undefined || value === null || value < 0) {
    return false;
  }
  const escapedValue = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const termPattern = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  if (!termPattern) {
    return false;
  }
  return new RegExp(`(?:${escapedValue}\\s*(?:%|[^\\n]{0,24}(?:${termPattern}))|(?:${termPattern})[^\\n]{0,24}${escapedValue})`, 'i')
    .test(normalized);
}

function hasExactTelemetryEcho(text, languageCode, validationContext = {}) {
  const normalized = normalizeTextForDedupe(text);
  const signals = validationContext.signals || {};
  if (signals.battery_level !== undefined) {
    const batteryTerms = getLanguageMap(BATTERY_TERMS, languageCode);
    if (normalized.includes(`${signals.battery_level}%`) || numberNearTerms(normalized, signals.battery_level, batteryTerms)) {
      return true;
    }
  }
  if (signals.unlocks_since_last_batch !== undefined) {
    const unlockTerms = getLanguageMap(UNLOCK_TERMS, languageCode);
    if (numberNearTerms(normalized, signals.unlocks_since_last_batch, unlockTerms)) {
      return true;
    }
  }
  return false;
}

function hasUnsupportedContextClaim(text, languageCode, validationContext = {}) {
  const hasTrafficContext = validationContext.contextFlags && validationContext.contextFlags.traffic === true;
  if (hasTrafficContext) {
    return false;
  }
  const trafficPatterns = (UNSUPPORTED_CONTEXT_PATTERNS.traffic[languageCode] || [])
    .concat(UNSUPPORTED_CONTEXT_PATTERNS.traffic[DEFAULT_LANGUAGE_CODE] || []);
  return trafficPatterns.some((pattern) => pattern.test(text));
}

function hasCoachingOrDirectiveShape(text, languageCode) {
  const patterns = (COACHING_PATTERNS[languageCode] || []).concat(COACHING_PATTERNS[DEFAULT_LANGUAGE_CODE] || []);
  return patterns.some((pattern) => pattern.test(text));
}

function rejectionReasonForText(text, languageCode, validationContext = {}) {
  const filterResult = validateLockScreenText(text, { maxLength: LOCK_SCREEN_TEXT_MAX_LENGTH });
  if (!filterResult.ok) return filterResult.reason;
  if (hasQuestionShapeWithoutMark(text)) return 'question';
  if (isGenericBadLockScreenPhrase(text)) return 'generic';
  if (hasInvalidRelativeDateClaim(text, languageCode, validationContext)) return 'date_claim';
  if (hasExactTelemetryEcho(text, languageCode, validationContext)) return 'telemetry_echo';
  if (hasUnsupportedContextClaim(text, languageCode, validationContext)) return 'unsupported_context';
  if (hasCoachingOrDirectiveShape(text, languageCode)) return 'coaching';
  return null;
}

function incrementReason(reasonCounts, reason) {
  if (!reason) {
    return;
  }
  reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
}

function collectUsablePhrases(phrases, languageCode, validationContext = {}, expectedSlotIds = null) {
  if (!Array.isArray(phrases)) {
    return null;
  }

  const seenTexts = new Set();
  const seenSlotIds = new Set();
  const expectedSlotSet = Array.isArray(expectedSlotIds) ? new Set(expectedSlotIds) : null;
  const accepted = [];
  const rejectedSlotIds = new Set();
  let rejectedCount = 0;
  const rejectionReasons = {};
  const reject = (reason, slotId) => {
    rejectedCount += 1;
    incrementReason(rejectionReasons, reason);
    if (expectedSlotSet && typeof slotId === 'string' && expectedSlotSet.has(slotId)) {
      rejectedSlotIds.add(slotId);
    }
  };
  for (const phrase of phrases) {
    if (!phrase || typeof phrase.text !== 'string') {
      reject('schema', phrase && phrase.slot_id);
      continue;
    }
    if (expectedSlotSet) {
      if (typeof phrase.slot_id !== 'string' || !expectedSlotSet.has(phrase.slot_id) || seenSlotIds.has(phrase.slot_id)) {
        reject('slot_id', phrase.slot_id);
        continue;
      }
      seenSlotIds.add(phrase.slot_id);
    }
    const text = phrase.text.trim();
    const reason = rejectionReasonForText(text, languageCode, validationContext);
    if (reason) {
      reject(reason, phrase.slot_id);
      continue;
    }
    if (languageCode && !isValidLanguageText(text, languageCode)) {
      reject('language', phrase.slot_id);
      continue;
    }

    const normalized = normalizeTextForDedupe(text);
    if (seenTexts.has(normalized)) {
      reject('duplicate', phrase.slot_id);
      continue;
    }
    seenTexts.add(normalized);

    accepted.push({
      slot_id: phrase.slot_id,
      text,
      style_id: STYLE_IDS.includes(phrase.style_id) ? phrase.style_id : null,
    });
  }

  if (expectedSlotSet) {
    const acceptedSlotIds = new Set(accepted.map((item) => item.slot_id));
    for (const slotId of expectedSlotSet) {
      if (!acceptedSlotIds.has(slotId)) {
        rejectedSlotIds.add(slotId);
      }
    }
  }

  return { accepted, rejectedCount, inputCount: phrases.length, rejectionReasons, rejectedSlotIds: [...rejectedSlotIds] };
}

function cleanUsablePhrases(phrases, languageCode, validationContext = {}) {
  const collected = collectUsablePhrases(phrases, languageCode, validationContext);
  if (!collected) {
    return null;
  }
  const styled = assignUniqueStyleIds(collected.accepted);
  const finalChecked = validateFinalBatch(styled);
  return finalChecked ? styled : null;
}

function assignUniqueStyleIds(items) {
  const usedStyles = new Set();
  return items.map((item) => {
    const style_id = STYLE_IDS.includes(item.style_id) && !usedStyles.has(item.style_id)
      ? item.style_id
      : pickFirstUnusedStyle(usedStyles);
    usedStyles.add(style_id);
    return { ...item, style_id };
  });
}

function validateFinalBatch(items) {
  if (!Array.isArray(items) || items.length !== BATCH_SIZE) {
    return false;
  }
  const seenTexts = new Set();
  const seenStyles = new Set();
  for (const item of items) {
    if (!item || typeof item.text !== 'string' || isUnusableLockScreenText(item.text)) {
      return false;
    }
    if (!STYLE_IDS.includes(item.style_id) || seenStyles.has(item.style_id)) {
      return false;
    }
    seenStyles.add(item.style_id);
    const normalized = normalizeTextForDedupe(item.text);
    if (seenTexts.has(normalized)) {
      return false;
    }
    seenTexts.add(normalized);
  }
  return true;
}

// Anchor-slot fallback text, warm/kind (see FALLBACK_PHRASES' own comment for
// why) with the same 5-set daily rotation as the general fallback pool, so
// the two mandatory anchors (greeting_name/goodnight_care) don't show the
// exact same line every day a real OpenAI outage happens to hit them. Only
// ru/en are authored directly (matches the pre-existing scope of this
// function); every other language still falls through to the English set --
// a pre-existing gap this task didn't extend to all 10 languages.
const ANCHOR_FALLBACK_TEXT = {
  goodnight_care: {
    ru: [
      'Телефону тоже нужен отдых',
      'Хорошего отдыха, экран подождёт',
      'Сегодняшний день был не зря',
      'Отдохни — ты его заслужил',
      'Пора дать себе передышку',
    ],
    en: [
      'Even a phone needs rest',
      'Rest well, the screen can wait',
      'Today mattered, even the quiet parts',
      "You've earned a proper rest tonight",
      'Time to let yourself pause completely',
    ],
  },
  greeting_name: {
    ru: [
      'Доброе утро. Один точный шаг экономит час',
      'Доброе утро — сегодня уже есть повод улыбнуться',
      'Доброе утро, день только начинается',
      'Доброе утро — ты уже на верном пути',
      'Доброе утро, сегодня точно будет что-то хорошее',
    ],
    en: [
      'Good morning. One precise step saves an hour',
      'Good morning, today already holds something good',
      "Good morning, you're off to a fine start",
      'Good morning, the day is still wide open',
      'Good morning, small good things are already close',
    ],
  },
};

function fallbackTextForSlot(slot, languageCode) {
  const byType = slot && ANCHOR_FALLBACK_TEXT[slot.type];
  if (!byType) {
    return null;
  }
  const variants = byType[languageCode] || byType.en;
  return variants[currentFallbackSetIndex()];
}

function pickFallbackTextForSlot(slot, languageCode, seenTexts, fallbackTexts) {
  const slotFallback = fallbackTextForSlot(slot, languageCode);
  if (slotFallback) {
    const normalized = normalizeTextForDedupe(slotFallback);
    if (!isUnusableLockScreenText(slotFallback) && !seenTexts.has(normalized)) {
      return slotFallback;
    }
  }

  for (const text of fallbackTexts) {
    const trimmed = text.trim();
    const normalized = normalizeTextForDedupe(trimmed);
    if (!isUnusableLockScreenText(trimmed) && !seenTexts.has(normalized)) {
      return trimmed;
    }
  }
  return null;
}

function assembleByExpectedSlotOrder(generated, languageCode, expectedSlots) {
  const fallbackPhrases = activeFallbackPhrases(languageCode);
  const shuffledFallback = [...fallbackPhrases].sort(() => Math.random() - 0.5);
  const generatedBySlot = new Map(generated.map((item) => [item.slot_id, item]));
  const seenTexts = new Set(generated.map((item) => normalizeTextForDedupe(item.text)));

  const result = expectedSlots.map((slot) => {
    const generatedItem = generatedBySlot.get(slot.slot_id);
    if (generatedItem) {
      return generatedItem;
    }
    const fallbackText = pickFallbackTextForSlot(slot, languageCode, seenTexts, shuffledFallback);
    if (!fallbackText) {
      return null;
    }
    seenTexts.add(normalizeTextForDedupe(fallbackText));
    return { slot_id: slot.slot_id, text: fallbackText, style_id: null };
  });

  if (result.some((item) => !item)) {
    return null;
  }
  return assignUniqueStyleIds(result);
}

function fillWithFallbackPhrases(generated, languageCode) {
  const result = [...generated];
  const seenTexts = new Set(result.map((item) => normalizeTextForDedupe(item.text)));
  const fallbackPhrases = activeFallbackPhrases(languageCode);
  const shuffledFallback = [...fallbackPhrases].sort(() => Math.random() - 0.5);

  for (const text of shuffledFallback) {
    if (result.length >= BATCH_SIZE) {
      break;
    }
    const trimmed = text.trim();
    const normalized = normalizeTextForDedupe(trimmed);
    if (isUnusableLockScreenText(trimmed) || seenTexts.has(normalized)) {
      continue;
    }
    seenTexts.add(normalized);
    result.push({ text: trimmed, style_id: null });
  }
  if (result.length !== BATCH_SIZE) {
    return null;
  }
  return assignUniqueStyleIds(result);
}

function assembleBatchFromGeneratedPhrases(phrases, languageCode, validationContext = {}, expectedSlots = null) {
  const expectedSlotIds = Array.isArray(expectedSlots) ? expectedSlots.map((slot) => slot.slot_id) : null;
  const collected = collectUsablePhrases(phrases, languageCode, validationContext, expectedSlotIds);
  if (!collected) {
    return null;
  }
  const generated = collected.accepted.slice(0, BATCH_SIZE);
  const fallbackFillCount = BATCH_SIZE - generated.length;
  const assembled = Array.isArray(expectedSlots)
    ? assembleByExpectedSlotOrder(generated, languageCode, expectedSlots)
    : fallbackFillCount > 0
      ? fillWithFallbackPhrases(generated, languageCode)
      : assignUniqueStyleIds(generated);

  if (!assembled || !validateFinalBatch(assembled)) {
    return {
      phrases: null,
      generatedCount: generated.length,
      rejectedCount: collected.rejectedCount,
      fallbackFillCount,
      reason: 'final_assembly_fallback',
      rejectionReasons: collected.rejectionReasons,
    };
  }

  return {
    phrases: assembled,
    generatedCount: generated.length,
    generatedSlotIds: generated.map((item) => item.slot_id),
    rejectedCount: collected.rejectedCount,
    fallbackFillCount,
    rejectionReasons: collected.rejectionReasons,
    rejectedSlotIds: collected.rejectedSlotIds,
    reason: fallbackFillCount === 0
      ? 'success'
      : generated.length === 0
        ? 'all_invalid_fallback'
        : 'partial_validation_fill',
  };
}

function formatRejectionReasons(rejectionReasons) {
  if (!rejectionReasons || Object.keys(rejectionReasons).length === 0) {
    return '';
  }
  return Object.entries(rejectionReasons)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reasonName, count]) => ` rejected_${reasonName}=${count}`)
    .join('');
}

function logBatchResult({ generatedCount, rejectedCount, fallbackFillCount, reason, rejectionReasons }) {
  console.log(
    `AI_BATCH_RESULT generated_count=${generatedCount} rejected_count=${rejectedCount} fallback_fill_count=${fallbackFillCount} reason=${reason}${formatRejectionReasons(rejectionReasons)}`
  );
}

function buildLoggedFallbackResult(languageCode, context, reason, rejectedCount = 0) {
  logBatchResult({
    generatedCount: 0,
    rejectedCount,
    fallbackFillCount: BATCH_SIZE,
    reason,
  });
  return { phrases: buildFallbackBatch(languageCode), source: 'fallback', context };
}

function buildLoggedOpenAiResult(assembly, context) {
  logBatchResult(assembly);
  const phrases = assembly.phrases.map((item) => ({ text: item.text, style_id: item.style_id }));
  return { phrases, source: assembly.generatedCount > 0 ? 'openai' : 'fallback', context };
}

function buildLoggedFinalAssemblyFallback(languageCode, context, assembly) {
  logBatchResult({
    generatedCount: assembly ? assembly.generatedCount : 0,
    rejectedCount: assembly ? assembly.rejectedCount : 0,
    fallbackFillCount: BATCH_SIZE,
    reason: 'final_assembly_fallback',
    rejectionReasons: assembly ? assembly.rejectionReasons : undefined,
  });
  return { phrases: buildFallbackBatch(languageCode), source: 'fallback', context };
}

function parseOpenAiBatchResponse(response) {
  const content = response &&
    response.choices &&
    response.choices[0] &&
    response.choices[0].message &&
    response.choices[0].message.content;
  const parsed = JSON.parse(content);
  if (!parsed || !Array.isArray(parsed.phrases)) {
    throw new Error('response did not contain phrases array');
  }
  return parsed;
}

function buildBatchResponseFormat(name, count) {
  return {
    type: 'json_schema',
    json_schema: {
      name,
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
                text: { type: 'string', maxLength: LOCK_SCREEN_TEXT_MAX_LENGTH },
                style_id: { type: 'string', enum: STYLE_IDS },
              },
              required: ['slot_id', 'text', 'style_id'],
              additionalProperties: false,
            },
          },
        },
        required: ['phrases'],
        additionalProperties: false,
      },
    },
  };
}

async function createOpenAiBatch(client, context, languageCode, count = BATCH_SIZE, schemaName = 'lock_screen_batch') {
  return client.chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: buildBatchResponseFormat(schemaName, count),
    messages: [
      { role: 'system', content: buildSystemPrompt(languageCode) },
      { role: 'user', content: context },
    ],
  });
}

async function regenerateRejectedSlots(client, basePayload, slots, rejectedSlotIds, languageCode, validationContext) {
  if (!Array.isArray(rejectedSlotIds) || rejectedSlotIds.length === 0) {
    return null;
  }
  const rejectedSlotSet = new Set(rejectedSlotIds);
  const repairSlots = slots.filter((slot) => rejectedSlotSet.has(slot.slot_id));
  if (repairSlots.length === 0) {
    return null;
  }
  const repairPayload = {
    ...basePayload,
    repair: 'rewrite_only_these_rejected_slots',
    slots: repairSlots.map((slot) => ({
      slot_id: slot.slot_id,
      type: slot.type,
      facts: slot.facts || {},
      constraints: slot.constraints || [],
      interest_hint: slot.interest_hint || undefined,
      gender_lean_hint: slot.gender_lean_hint || undefined,
    })),
  };
  const response = await createOpenAiBatch(
    client,
    JSON.stringify(repairPayload),
    languageCode,
    repairSlots.length,
    'lock_screen_repair'
  );
  const parsed = parseOpenAiBatchResponse(response);
  const repaired = collectUsablePhrases(
    parsed.phrases,
    languageCode,
    validationContext,
    repairSlots.map((slot) => slot.slot_id)
  );
  return repaired && repaired.accepted.length > 0 ? repaired.accepted : null;
}

function extractUsedCategoriesFromSlots(slots) {
  return Array.isArray(slots)
    ? slots
      .map((slot) => slot.bank_category)
      .filter((category) => BANK_CATEGORIES.includes(category))
    : [];
}
// languageCode is expected to already be a resolved, known key of
// FALLBACK_PHRASES (i.e. the output of resolveTargetLanguageCode) — the
// DEFAULT_LANGUAGE_CODE fallback here is defense in depth for a caller that
// passes something else (e.g. undefined), not the primary resolution path.
function pickRandomFallbackPhrase(languageCode) {
  const phrases = activeFallbackPhrases(languageCode);
  return phrases[Math.floor(Math.random() * phrases.length)];
}

// Generalizes the old isValidEnglishText heuristic to any of the 10
// supported languages: SYSTEM_PROMPT demands a specific target language, but
// gpt-4o-mini occasionally drifts into another language on an individual
// phrase within an otherwise-correct batch (observed in practice for
// Russian, not theoretical). Checks only for "at least one character in the
// expected script" — a full-phrase drift into a different script family
// (e.g. Chinese requested, English-only text came back) has none, so it's
// caught; it does not try to catch drift between languages that share a
// script (e.g. French text when Italian was requested), same limitation the
// original English/Cyrillic-only check had.
function isValidLanguageText(text, languageCode) {
  const language = SUPPORTED_LANGUAGES[languageCode] || SUPPORTED_LANGUAGES[DEFAULT_LANGUAGE_CODE];
  return language.scriptCheck.test(text);
}

function weekdayForDateString(date) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      weekday: 'long',
    }).format(new Date(`${date}T00:00:00Z`));
  } catch (err) {
    return null;
  }
}

function addDaysToDateString(date, days) {
  const instant = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(instant.getTime())) {
    return null;
  }
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

// Date/day-of-week is deliberately NOT a client-sent signal (see
// PRODUCT_REBUILD_PLAN.md server contract docs) — the server already has the
// device's IANA timezone (e.g. "Asia/Almaty") from /register
// (TimeZone.getDefault().getID() on the Android side), so it can compute the
// device's local date/weekday itself rather than trusting/parsing a second
// client-sent value that would just have to agree with the timezone anyway.
// Returns {dateContext, unavailableReason}. dateContext is null if there's no
// timezone on file yet, or it's not a timezone Intl recognizes.
function isValidDateString(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
    && !Number.isNaN(new Date(`${date}T00:00:00Z`).getTime());
}

function resolveLocalDateContext(timezone, forcedLocalDate = null) {
  if (!timezone) {
    return { dateContext: null, unavailableReason: 'missing_timezone' };
  }
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    const parts = formatter.formatToParts(new Date());
    const get = (type) => parts.find((p) => p.type === type)?.value;
    const computedDate = `${get('year')}-${get('month')}-${get('day')}`;
    const date = isValidDateString(forcedLocalDate) ? forcedLocalDate : computedDate;
    const weekday = date === computedDate ? get('weekday') : weekdayForDateString(date);
    const time = `${get('hour')}:${get('minute')}`;
    const tomorrowDate = addDaysToDateString(date, 1);
    const tomorrowWeekday = tomorrowDate ? weekdayForDateString(tomorrowDate) : null;
    if (!weekday || !time || !tomorrowDate || !tomorrowWeekday) {
      return { dateContext: null, unavailableReason: 'invalid_timezone' };
    }
    return {
      dateContext: {
        date,
        weekday,
        time,
        tomorrow_date: tomorrowDate,
        tomorrow_weekday: tomorrowWeekday,
      },
      unavailableReason: null,
    };
  } catch (err) {
    return { dateContext: null, unavailableReason: 'invalid_timezone' };
  }
}

function getLocalDateContext(timezone) {
  return resolveLocalDateContext(timezone).dateContext;
}

// Formats `instant` as the calendar date (YYYY-MM-DD) it falls on within
// `timezone` — the building block both getLocalDateContext (today's date)
// and getDaysSinceInstall (below) use, so "what calendar day is this" is
// computed the same way in both places, consistently in the device's own
// timezone rather than server UTC. Returns null if timezone is missing/not
// recognized by Intl (same convention as getLocalDateContext).
function getLocalCalendarDate(instant, timezone) {
  if (!timezone) {
    return null;
  }
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = formatter.formatToParts(instant);
    const get = (type) => parts.find((p) => p.type === type)?.value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch (err) {
    return null;
  }
}

// Days elapsed between a device's first appearance in the system
// (devices.created_at — set once at row creation by db/index.js's
// DEFAULT (datetime('now')), never touched again by register.js's
// ON CONFLICT update) and now, counted in the device's own local calendar
// days (see PRODUCT_REBUILD_PLAN.md §5.1) — not server UTC days, so the
// count doesn't roll over an hour or two before/after the user's actual
// local midnight, and not raw elapsed hours/24h periods either.
//
// The day of registration itself is day 0, not day 1 — a device that
// registered 10 minutes ago should read as "just installed" in the prompt,
// not "1 day in". Implemented by converting both createdAtUtc and "now" to
// calendar-date strings in the device's timezone (getLocalCalendarDate
// above) and diffing those as UTC midnights: since both are already
// timezone-adjusted calendar dates at that point, the ms difference divides
// out to an exact whole-day count with no further DST/offset arithmetic
// needed.
//
// Returns null (same "not enough info yet" convention as
// getLocalDateContext) if there's no timezone on file, or createdAtUtc is
// missing/unparseable — e.g. the very first /batch call for a brand-new
// device, made with the pre-insert `device` stub from routes/batch.js that
// has no created_at yet.
function getDaysSinceInstall(createdAtUtc, timezone) {
  if (!createdAtUtc || !timezone) {
    return null;
  }
  // SQLite's datetime('now') stores 'YYYY-MM-DD HH:MM:SS' as UTC but with no
  // 'Z'/offset suffix — append one explicitly so Date parses it as UTC
  // rather than as local server time.
  const installInstant = new Date(`${createdAtUtc.replace(' ', 'T')}Z`);
  if (Number.isNaN(installInstant.getTime())) {
    return null;
  }
  const installDate = getLocalCalendarDate(installInstant, timezone);
  const nowDate = getLocalCalendarDate(new Date(), timezone);
  if (!installDate || !nowDate) {
    return null;
  }
  const daysDiff = Math.round(
    (Date.parse(`${nowDate}T00:00:00Z`) - Date.parse(`${installDate}T00:00:00Z`)) / 86400000
  );
  // Floored at 0 defensively (should not go negative in practice — both
  // dates come from the same device's own timezone conversion — but a
  // negative "days since install" would be a confusing thing to hand the
  // model if clock skew or an edge case ever produced one).
  return daysDiff >= 0 ? daysDiff : 0;
}

// languageCode: same contract as pickRandomFallbackPhrase — pass the
// already-resolved target language (resolveTargetLanguageCode's output);
// defaults to DEFAULT_LANGUAGE_CODE when omitted, so existing callers that
// don't pass a language (e.g. tests) keep the original English behavior.
// Uses pickUniqueStyles (not an independent pickRandomStyle() per phrase) so
// the fallback path also never repeats a style_id within one batch.
function buildFallbackBatch(languageCode = DEFAULT_LANGUAGE_CODE) {
  const phrases = activeFallbackPhrases(languageCode);
  const shuffled = [...phrases].sort(() => Math.random() - 0.5);
  const styles = pickUniqueStyles(BATCH_SIZE);
  return shuffled.slice(0, BATCH_SIZE).map((text, i) => ({
    text,
    style_id: styles[i],
  }));
}

// Computes the user's age in whole years from device.birth_date (an
// ISO-ish date string from the client, e.g. "1990-05-20"). Returns null if
// birth_date is missing or unparseable, so callers can omit the field
// entirely rather than send a garbage value to the model.
function computeAge(birthDate) {
  if (!birthDate) {
    return null;
  }
  const dob = new Date(birthDate);
  if (Number.isNaN(dob.getTime())) {
    return null;
  }
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDay = (now.getUTCMonth() - dob.getUTCMonth()) || (now.getUTCDate() - dob.getUTCDate());
  if (monthDay < 0) {
    age -= 1;
  }
  return age >= 0 ? age : null;
}

// Builds the compact slot-based user payload sent to the model. The planner
// has already decided WHAT the batch should cover; this payload asks OpenAI
// only to write one phrase for each selected slot.
//
// languageCode: the already-resolved target language (resolveTargetLanguageCode's
// output) — reported in `now.language` as a human name so the model doesn't
// have to map an ISO code itself.
// slots: exactly BATCH_SIZE planner-selected editorial tasks. The full
// candidate pool/bank is deliberately not sent.
function windowContextFor(window) {
  return WINDOW_CONTEXT[window] || { id: window };
}

function buildContextPrompt(device, window, signals, weather, languageCode, slots, dateContext) {
  const profile = {};
  if (device.name) profile.name = device.name;
  if (device.gender) profile.gender = device.gender;
  const age = computeAge(device.birth_date);
  if (age !== null) profile.age = age;

  // `language` is the resolved GENERATION target (resolveTargetLanguageCode's
  // output, e.g. falls back to English if the device's own language isn't
  // supported) -- not the same thing as the device's raw system_language
  // signal, so we also surface `device_language` below whenever the two
  // differ, otherwise the model would have no way to know a fallback
  // happened. `timezone` itself is deliberately NOT included here (unlike
  // the old "; "-joined context) -- the model only ever needs the derived
  // date/weekday/days_since_install below, not the raw IANA string.
  const now = { language: SUPPORTED_LANGUAGES[languageCode].name, window: windowContextFor(window) };
  if (signals && signals.system_language && signals.system_language !== languageCode) {
    now.device_language = signals.system_language;
  }
  const ipCountryCode = weather && typeof weather.countryCode === 'string' && weather.countryCode
    ? weather.countryCode
    : null;
  if (ipCountryCode) {
    now.country = ipCountryCode;
    now.country_source = 'ip_approximate';
    if (signals && signals.region !== undefined && signals.region !== ipCountryCode) {
      now.device_region = signals.region;
    }
  } else if (signals && signals.region !== undefined) {
    now.country = signals.region;
    now.country_source = 'device_locale';
  }
  if (device.timezone) {
    if (dateContext) {
      now.date = dateContext.date;
      now.weekday = dateContext.weekday;
      now.time = dateContext.time;
      now.tomorrow = [dateContext.tomorrow_date, dateContext.tomorrow_weekday];
    }
    const daysSinceInstall = getDaysSinceInstall(device.created_at, device.timezone);
    if (daysSinceInstall !== null) {
      now.days_since_install = daysSinceInstall;
    }
  }

  const ctx = {
    lang: languageCode,
    profile,
    now,
    slots: Array.isArray(slots)
      ? slots.map((slot) => ({
        slot_id: slot.slot_id,
        type: slot.type,
        facts: slot.facts || {},
        constraints: slot.constraints || [],
        // Target length for this specific slot (see TYPE_LENGTH_HINTS in
        // slotPlanner.js) -- 'short'/'medium'/'long' are targets the model
        // should aim for, not the hard cap; LOCK_SCREEN_TEXT_MAX_LENGTH (70)
        // is enforced separately regardless of this hint (see
        // buildSystemPrompt/validateFinalBatch).
        length_hint: slot.length_hint || 'medium',
        // Only present on the small, server-selected subset of slots
        // SlotPlanner picked as interest-aware (see selectInterestAwareSlots
        // in slotPlanner.js) -- omitted (not even an empty/false value) for
        // every other slot, so this never grows the per-slot payload shape
        // for the common case, and never carries the user's full interests
        // list, only the one compact tag relevant to this specific slot.
        interest_hint: slot.interest_hint || undefined,
        // Same shape/timing as interest_hint, but from selectGenderLeanSlot
        // -- present on at most ONE slot in the whole batch (see that
        // function's own comment for why a hard single-slot cap matters
        // here specifically: gender must stay rare, not a recurring theme).
        gender_lean_hint: slot.gender_lean_hint || undefined,
      }))
      : [],
  };
  if (Object.keys(profile).length === 0) delete ctx.profile;

  return JSON.stringify(ctx);
}

// Builds the SYSTEM_PROMPT for a specific target language. Function of
// languageCode only (no country code) so the static prefix is byte-identical
// across every request in the same language regardless of which device's
// country happens to be set -- country code now travels only in the per-request
// context (buildContextPrompt's `now.country`), which lets an OpenAI-side
// prompt cache match this whole prefix across users of the same language
// instead of missing on the old regionCode-conditional branch.
//
// The "occasional country fact" instruction is therefore now unconditional
// static text (previously only appended when a region was present) -- it's
// a no-op on a request with no region in context, and still deliberately
// conservative (general-knowledge, uncontested facts only) since this path
// has no web search, unlike dailyContentBank.js's Responses API call.
//
// Shape of the output (exactly BATCH_SIZE {slot_id, text, style_id} objects)
// is enforced via the Structured Outputs json_schema passed to the API call
// in generateBatch, not described in this text -- see the call site for why.
function buildSystemPrompt(languageCode) {
  const languageName = SUPPORTED_LANGUAGES[languageCode].name;
  return `Ты — добрый, умный и внимательный AI-компаньон на экране блокировки, не quote/trivia/coach-приложение. Давай короткие мысли монологом: 1 предложение, емко, полезно, разнообразно, с теплом и вниманием к дню человека.
Язык: ${languageName}. На каждый slot_id верни ровно одну строку и уникальный style_id.
Запрет: ?, «пусть», открытки, уют/чай/тихий свет/мысли/мечты/магия/чудеса/счастье/фея/чайник, ночная поэзия про ночь/луну/звезды/тишину/покой/шорох/фонари/небо/свечи/гирлянды, «верь в себя», «ты справишься», вода, коучинг, выдуманные факты, выдуманные названия мероприятий/фильмов/выставок.
ЗАПРЕЩЕНО использовать повелительное наклонение и команды (используй, выбери, держи, создай, читай, проверяй). Пиши в формате короткого факта или наблюдения.
Экономь слова, но не сокращай мысль искусственно — длина зависит от slot.length_hint, см. ниже.
По типу slot: greeting_name — тёплое личное приветствие по имени (если оно есть в profile) и лёгкое светлое напутствие на день, каждый день другими словами; goodnight_care — мягкое пожелание доброго отдыха по имени (если есть), без потока «тишина/звёзды/фонари»; weather_lifehack — только простая бытовая фраза про одежду, зонт, обувь или солнце, без температуры и любых цифр; context_signal — тёплая, заботливая реакция на facts.signal (низкий заряд/много разблокировок/поздний час), без чисел и без тревожности; holiday_today/history_today — по делу, не энциклопедия; smart_humor_observation — тонкое ироничное наблюдение об обыденной жизни, не анекдот и не насмешка; city_afisha — только общее наблюдение о городской жизни/сезоне (парки, вечерние прогулки, привычки города), НИКОГДА не выдумывай конкретное название события/фильма/выставки или дату; free_ai_thought — одна короткая, по-настоящему интересная мысль о людях или цифровом мире.
Только факты из slot/profile/now; погода только бытовыми словами без температуры и цифр, но опирайся на facts.temp_band/facts.condition_lean, если они есть — разная погода должна звучать по-разному, а не одним и тем же «оденься теплее» каждый раз; утром можно имя 1 раз; gender/age дают только аккуратный практичный оттенок, без стереотипов и обращений вроде «для настоящих мужчин» или «для девочек»; facts.age_bracket (teen/young_adult/adult/mature/senior) можно использовать только как мягкий ориентир уместности темы и сложности тона, никогда не называя сам возраст или диапазон вслух; interest_hint и gender_lean_hint используй незаметно, без «since you like».
Персонализация всегда должна выглядеть естественной, а не как отчёт о данных пользователя: никогда не пиши прямо «ты выбрал спорт», «раз тебе нравится X», «поскольку тебе N лет», «мы видим, что ты разблокировал телефон N раз» — только едва заметный сдвиг темы или тона, без ссылки на источник.
context_signal: many_unlocks — тёплое, ненавязчивое наблюдение, никогда не упрёк и не «ты слишком много сидишь в телефоне»; low_battery — короткий практичный контекст без нравоучений; late_hour — спокойный, некатегоричный тон, без предположений о том, что человек уже спит.
phone_trend (facts.unlocks_vs_yesterday/facts.steps_vs_yesterday: higher/lower) — построй на этом естественное наблюдение о дне, а не сухую констатацию тренда, и никогда не называй точные числа.
now.window.focus задаёт общее настроение НЕ закреплённых по типу слотов (free_ai_thought/everyday_lifehack/smart_humor_observation/city_afisha/context_signal/seasonal и похожих) для текущего времени суток: утром — старт дня и лёгкое планирование, днём — рабочий темп и бытовые наблюдения, вечером — переключение и итоги дня, ночью — спокойные мысли и минимум активного тона; не называй это поле и не объясняй эту логику вслух.
Каждый slot несёт свой length_hint — это ОРИЕНТИР по диапазону, не цель, к которой надо тянуться: "short" — примерно 10-20 символов, мысль в одно мгновение; "medium" — примерно 21-40 символов, обычная фраза; "long" — РАЗРЕШЕНИЕ (не обязанность) раскрыть мысль подробнее, примерно 41-60 символов, но только если дополнительное содержание реально делает фразу интереснее — иначе короткая точная фраза всегда лучше растянутой. Никогда не растягивай уже законченную мысль ради попадания в диапазон и не пиши "впритык" к границе: если мысль естественно закончилась на 27 символах — оставь 27, а не дописывай слова до 40. В батче длины должны заметно отличаться друг от друга: большинство фраз — short/medium, long — меньшинство (ощутимо меньше половины батча), не подряд одна за другой и не через одинаковый интервал, а естественно, где материал того стоит.
${LOCK_SCREEN_TEXT_MAX_LENGTH} символов — это ТОЛЬКО аварийный технический потолок (жёсткая защита от переполнения экрана), никогда не целевая длина ни для одного length_hint. Только JSON по схеме.`;
}

/**
 * Generates a batch of {text, style_id} phrases for a device.
 * Falls back to a local static batch if no API key is configured or the
 * OpenAI call fails for any reason — the endpoint should never 500 just
 * because content generation had a bad day.
 *
 * @param {object} device - row from the devices table (or a stub {device_id})
 * @param {string} window - 'morning' | 'day' | 'evening' | 'night'
 * @param {object} [signals] - optional device signals from deviceSignals.js
 * @param {object} [weather] - optional weather from weather.js (resolveWeather)
 * @param {object} [phoneTrends] - semantic phone trends from phoneAnalytics.js
 * @returns {Promise<{phrases: Array<{text: string, style_id: string}>, source: 'openai'|'fallback'}>}
 */
async function generateBatch(device, window, signals, weather, phoneTrends = {}, options = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  const languageCode = resolveTargetLanguageCode(signals);
  const { dateContext, unavailableReason } = resolveLocalDateContext(device.timezone, options.localDate);
  if (!dateContext && unavailableReason) {
    console.warn(`DATE_CONTEXT_UNAVAILABLE reason=${unavailableReason}`);
  }

  // Bank items are keyed by the device's own local calendar date (matches
  // device_shown_categories' "today"), not the server's UTC bank_date --
  // reuses the same getLocalCalendarDate this file already uses for
  // days-since-install. Both device.timezone and today's bank can be
  // missing/empty (new device, cron hasn't run yet) -- selectBankItemsForDevice
  // already returns [] in that case, so bankItems degrades to "no bank
  // content this batch" rather than failing.
  const deviceLocalDate = dateContext ? dateContext.date : null;
  const countryCode = weather && typeof weather.countryCode === 'string' && weather.countryCode
    ? weather.countryCode
    : signals && typeof signals.region === 'string'
      ? signals.region
      : null;
  const bankItems = selectBankItemsForDevice(
    device.device_id,
    getBankDateString(),
    deviceLocalDate,
    device.gender,
    countryCode
  );
  const recentContentMemory = getRecentContentMemory(device.device_id);
  const recallCandidate = getRecallCandidate(device.device_id);
  const { slots } = planSlots({
    device,
    window,
    dateContext,
    weather,
    bankItems,
    phoneTrends,
    recallCandidate,
    signals,
  }, { recentContentMemory });

  const context = buildContextPrompt(device, window, signals, weather, languageCode, slots, dateContext);
  const validationContext = {
    dateContext,
    signals,
    weather,
    contextFlags: { traffic: false },
  };

  if (!apiKey) {
    return buildLoggedFallbackResult(languageCode, context, 'no_api_key_fallback');
  }

  let response;
  let client;
  try {
    // Lazy require: avoids crashing at startup if the package is present but
    // no key is set yet, and keeps the fallback path dependency-free.
    const OpenAI = require('openai');
    client = new OpenAI({ apiKey });
    response = await createOpenAiBatch(client, context, languageCode);

  } catch (err) {
    console.error(`AI_BATCH_ERROR reason=openai_error error=${err.name || 'Error'}`);
    return buildLoggedFallbackResult(languageCode, context, 'openai_error');
  }

  let parsed;
  try {
    parsed = parseOpenAiBatchResponse(response);
  } catch (err) {
    console.error(`AI_BATCH_ERROR reason=parse_or_schema_error error=${err.name || 'Error'}`);
    return buildLoggedFallbackResult(languageCode, context, 'parse_or_schema_error');
  }

  let assembly;
  try {
    assembly = assembleBatchFromGeneratedPhrases(parsed.phrases, languageCode, validationContext, slots);
  } catch (err) {
    console.error(`AI_BATCH_ERROR reason=final_assembly_fallback error=${err.name || 'Error'}`);
    return buildLoggedFallbackResult(languageCode, context, 'final_assembly_fallback');
  }

  if (!assembly) {
    return buildLoggedFallbackResult(languageCode, context, 'parse_or_schema_error');
  }

  if (assembly.rejectedSlotIds && assembly.rejectedSlotIds.length > 0 && assembly.generatedCount > 0) {
    try {
      const basePayload = JSON.parse(context);
      const repaired = await regenerateRejectedSlots(
        client,
        basePayload,
        slots,
        assembly.rejectedSlotIds,
        languageCode,
        validationContext
      );
      if (repaired && repaired.length > 0) {
        const acceptedSlotIds = new Set(assembly.generatedSlotIds);
        const merged = parsed.phrases
          .filter((phrase) => acceptedSlotIds.has(phrase.slot_id))
          .concat(repaired);
        const repairedAssembly = assembleBatchFromGeneratedPhrases(merged, languageCode, validationContext, slots);
        if (repairedAssembly && repairedAssembly.phrases) {
          repairedAssembly.reason = repairedAssembly.rejectedCount === 0
            ? 'success_after_slot_regeneration'
            : 'partial_slot_regeneration';
          assembly = repairedAssembly;
        }
      }
    } catch (err) {
      console.error(`AI_BATCH_ERROR reason=slot_regeneration_error error=${err.name || 'Error'}`);
    }
  }

  if (!assembly.phrases) {
    return buildLoggedFinalAssemblyFallback(languageCode, context, assembly);
  }

  // Record planned daily-bank categories for this batch. With slot-based
  // generation the model no longer chooses categories; the server does, so the
  // repeat-avoidance signal comes from selected slots rather than model labels.
  const usedCategories = extractUsedCategoriesFromSlots(slots);
  recordShownCategories(device.device_id, deviceLocalDate, usedCategories);
  recordShownContentMemory(device.device_id, slots, assembly.generatedSlotIds);
  recordLearnedWords(device.device_id, slots, assembly.generatedSlotIds);
  recordRecalledWords(device.device_id, slots, assembly.generatedSlotIds);

  return buildLoggedOpenAiResult(assembly, context);
}

module.exports = {
  generateBatch,
  buildFallbackBatch,
  _test: {
    cleanUsablePhrases,
    hasQuestionMark,
    hasQuestionShapeWithoutMark,
    isGenericBadLockScreenPhrase,
    assembleBatchFromGeneratedPhrases,
    validateFinalBatch,
    resolveTargetLanguageCode,
    windowContextFor,
    resolveLocalDateContext,
    buildContextPrompt,
    buildSystemPrompt,
    SUPPORTED_LANGUAGES,
    fallbackTextForSlot,
    currentFallbackSetIndex,
    LOCK_SCREEN_TEXT_MAX_LENGTH,
    isUnusableLockScreenText,
  },
};
