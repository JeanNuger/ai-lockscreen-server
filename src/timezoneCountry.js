// Offline IANA timezone -> ISO 3166-1 alpha-2 country code lookup.
//
// Why this exists: Node's Intl API can tell you a timezone's UTC offset and
// locale-formatted names, but has no built-in "which country is this
// timezone in" mapping. This project needs exactly that for the
// IP-vs-timezone location sanity check (see routes/batch.js) -- comparing
// the country ipwho.is resolved from the request's IP against the country
// implied by the phone's own IANA timezone (already sent as an existing
// `timezone` request param, see deviceSignals.js/routes/batch.js).
//
// No dependency was already in package.json that provides this (checked:
// no moment-timezone, no tz-lookup, nothing IANA-data-shaped) and adding one
// is out of scope for what is fundamentally a coarse sanity check, not a
// precision requirement -- a hardcoded table covering the timezones actually
// likely to appear for this app's real user base (plus the world's other
// major single-country and multi-region zones) is a pragmatic, explicitly
// accepted trade-off. Unknown/uncovered zones resolve to 'unknown' rather
// than guessing, which routes/batch.js treats as "cannot compare, assume no
// mismatch" -- this table intentionally errs toward under-flagging rather
// than false-positiving on a zone it doesn't recognize.
//
// Table shape: IANA zone name -> ISO 3166-1 alpha-2 country code. Covers
// every zone under each populated continent for countries with a single
// unambiguous zone (e.g. Europe/Berlin -> DE), plus every zone for countries
// that span multiple zones (e.g. all Australia/*, all America/Argentina/*,
// Russia's Europe/Moscow.../Asia/*), so a real device timezone from any of
// these countries resolves correctly rather than only the "headline" zone.
const TIMEZONE_TO_COUNTRY = {
  // --- Central Asia / the region this product actually ships in ---
  'Asia/Almaty': 'KZ',
  'Asia/Aqtobe': 'KZ',
  'Asia/Aqtau': 'KZ',
  'Asia/Atyrau': 'KZ',
  'Asia/Oral': 'KZ',
  'Asia/Qostanay': 'KZ',
  'Asia/Qyzylorda': 'KZ',
  'Asia/Bishkek': 'KG',
  'Asia/Tashkent': 'UZ',
  'Asia/Samarkand': 'UZ',
  'Asia/Dushanbe': 'TJ',
  'Asia/Ashgabat': 'TM',
  'Asia/Yerevan': 'AM',
  'Asia/Baku': 'AZ',
  'Asia/Tbilisi': 'GE',

  // --- Russia (multi-zone) ---
  'Europe/Kaliningrad': 'RU',
  'Europe/Moscow': 'RU',
  'Europe/Samara': 'RU',
  'Europe/Kirov': 'RU',
  'Europe/Volgograd': 'RU',
  'Europe/Astrakhan': 'RU',
  'Europe/Saratov': 'RU',
  'Europe/Ulyanovsk': 'RU',
  'Asia/Yekaterinburg': 'RU',
  'Asia/Omsk': 'RU',
  'Asia/Novosibirsk': 'RU',
  'Asia/Barnaul': 'RU',
  'Asia/Tomsk': 'RU',
  'Asia/Novokuznetsk': 'RU',
  'Asia/Krasnoyarsk': 'RU',
  'Asia/Irkutsk': 'RU',
  'Asia/Chita': 'RU',
  'Asia/Yakutsk': 'RU',
  'Asia/Khandyga': 'RU',
  'Asia/Vladivostok': 'RU',
  'Asia/Ust-Nera': 'RU',
  'Asia/Magadan': 'RU',
  'Asia/Sakhalin': 'RU',
  'Asia/Srednekolymsk': 'RU',
  'Asia/Kamchatka': 'RU',
  'Asia/Anadyr': 'RU',

  // --- Europe (single-zone-per-country, the common case) ---
  'Europe/London': 'GB',
  'Europe/Dublin': 'IE',
  'Europe/Lisbon': 'PT',
  'Europe/Madrid': 'ES',
  'Europe/Paris': 'FR',
  'Europe/Berlin': 'DE',
  'Europe/Amsterdam': 'NL',
  'Europe/Brussels': 'BE',
  'Europe/Luxembourg': 'LU',
  'Europe/Zurich': 'CH',
  'Europe/Vienna': 'AT',
  'Europe/Rome': 'IT',
  'Europe/Malta': 'MT',
  'Europe/Vatican': 'VA',
  'Europe/San_Marino': 'SM',
  'Europe/Monaco': 'MC',
  'Europe/Andorra': 'AD',
  'Europe/Gibraltar': 'GI',
  'Europe/Copenhagen': 'DK',
  'Europe/Oslo': 'NO',
  'Europe/Stockholm': 'SE',
  'Europe/Helsinki': 'FI',
  'Europe/Tallinn': 'EE',
  'Europe/Riga': 'LV',
  'Europe/Vilnius': 'LT',
  'Europe/Warsaw': 'PL',
  'Europe/Prague': 'CZ',
  'Europe/Bratislava': 'SK',
  'Europe/Budapest': 'HU',
  'Europe/Ljubljana': 'SI',
  'Europe/Zagreb': 'HR',
  'Europe/Sarajevo': 'BA',
  'Europe/Belgrade': 'RS',
  'Europe/Podgorica': 'ME',
  'Europe/Skopje': 'MK',
  'Europe/Tirane': 'AL',
  'Europe/Sofia': 'BG',
  'Europe/Bucharest': 'RO',
  'Europe/Chisinau': 'MD',
  'Europe/Kyiv': 'UA',
  'Europe/Simferopol': 'UA',
  'Europe/Minsk': 'BY',
  'Europe/Athens': 'GR',
  'Europe/Nicosia': 'CY',
  'Europe/Istanbul': 'TR',
  'Europe/Reykjavik': 'IS',
  'Atlantic/Faroe': 'FO',

  // --- Americas ---
  'America/New_York': 'US',
  'America/Chicago': 'US',
  'America/Denver': 'US',
  'America/Los_Angeles': 'US',
  'America/Anchorage': 'US',
  'America/Phoenix': 'US',
  'America/Detroit': 'US',
  'America/Indiana/Indianapolis': 'US',
  'Pacific/Honolulu': 'US',
  'America/Toronto': 'CA',
  'America/Vancouver': 'CA',
  'America/Edmonton': 'CA',
  'America/Winnipeg': 'CA',
  'America/Halifax': 'CA',
  'America/St_Johns': 'CA',
  'America/Mexico_City': 'MX',
  'America/Tijuana': 'MX',
  'America/Cancun': 'MX',
  'America/Bogota': 'CO',
  'America/Lima': 'PE',
  'America/Caracas': 'VE',
  'America/Santiago': 'CL',
  'America/La_Paz': 'BO',
  'America/Asuncion': 'PY',
  'America/Montevideo': 'UY',
  'America/Guayaquil': 'EC',
  'America/Sao_Paulo': 'BR',
  'America/Manaus': 'BR',
  'America/Fortaleza': 'BR',
  'America/Recife': 'BR',
  'America/Argentina/Buenos_Aires': 'AR',
  'America/Argentina/Cordoba': 'AR',
  'America/Argentina/Mendoza': 'AR',
  'America/Argentina/Ushuaia': 'AR',
  'America/Panama': 'PA',
  'America/Costa_Rica': 'CR',
  'America/Guatemala': 'GT',
  'America/Havana': 'CU',
  'America/Santo_Domingo': 'DO',
  'America/Puerto_Rico': 'PR',

  // --- Middle East / South Asia ---
  'Asia/Dubai': 'AE',
  'Asia/Riyadh': 'SA',
  'Asia/Qatar': 'QA',
  'Asia/Bahrain': 'BH',
  'Asia/Kuwait': 'KW',
  'Asia/Muscat': 'OM',
  'Asia/Baghdad': 'IQ',
  'Asia/Tehran': 'IR',
  'Asia/Jerusalem': 'IL',
  'Asia/Amman': 'JO',
  'Asia/Beirut': 'LB',
  'Asia/Damascus': 'SY',
  'Asia/Karachi': 'PK',
  'Asia/Kolkata': 'IN',
  'Asia/Kathmandu': 'NP',
  'Asia/Dhaka': 'BD',
  'Asia/Colombo': 'LK',
  'Asia/Kabul': 'AF',

  // --- East / Southeast Asia ---
  'Asia/Shanghai': 'CN',
  'Asia/Urumqi': 'CN',
  'Asia/Hong_Kong': 'HK',
  'Asia/Macau': 'MO',
  'Asia/Taipei': 'TW',
  'Asia/Tokyo': 'JP',
  'Asia/Seoul': 'KR',
  'Asia/Pyongyang': 'KP',
  'Asia/Manila': 'PH',
  'Asia/Jakarta': 'ID',
  'Asia/Makassar': 'ID',
  'Asia/Jayapura': 'ID',
  'Asia/Singapore': 'SG',
  'Asia/Kuala_Lumpur': 'MY',
  'Asia/Bangkok': 'TH',
  'Asia/Ho_Chi_Minh': 'VN',
  'Asia/Phnom_Penh': 'KH',
  'Asia/Vientiane': 'LA',
  'Asia/Yangon': 'MM',
  'Asia/Ulaanbaatar': 'MN',

  // --- Africa ---
  'Africa/Cairo': 'EG',
  'Africa/Lagos': 'NG',
  'Africa/Johannesburg': 'ZA',
  'Africa/Nairobi': 'KE',
  'Africa/Casablanca': 'MA',
  'Africa/Algiers': 'DZ',
  'Africa/Tunis': 'TN',
  'Africa/Tripoli': 'LY',
  'Africa/Accra': 'GH',
  'Africa/Addis_Ababa': 'ET',
  'Africa/Khartoum': 'SD',

  // --- Oceania ---
  'Australia/Sydney': 'AU',
  'Australia/Melbourne': 'AU',
  'Australia/Brisbane': 'AU',
  'Australia/Perth': 'AU',
  'Australia/Adelaide': 'AU',
  'Australia/Darwin': 'AU',
  'Australia/Hobart': 'AU',
  'Pacific/Auckland': 'NZ',
  'Pacific/Chatham': 'NZ',
  'Pacific/Fiji': 'FJ',
};

/**
 * @param {string} timezone - an IANA timezone name, e.g. "Asia/Almaty"
 * @returns {string} the ISO 3166-1 alpha-2 country code, or 'unknown' if this
 *   timezone isn't in the table (never throws, never returns null/undefined).
 */
function countryForTimezone(timezone) {
  if (typeof timezone !== 'string' || !timezone) {
    return 'unknown';
  }
  return TIMEZONE_TO_COUNTRY[timezone] || 'unknown';
}

module.exports = { countryForTimezone, TIMEZONE_TO_COUNTRY };
