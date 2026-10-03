require('dotenv').config();

const { generateDailyBank } = require('./dailyContentBank');
const { generateAfishaIfFriday } = require('./afishaSearch');

(async () => {
  const { savedCount, error } = await generateDailyBank();

  if (error) {
    console.error(`Daily Bank generation failed: ${error}`);
  } else {
    console.log(`Daily Bank generated successfully: ${savedCount} rows saved`);
  }

  // Fridays only: the weekend events poster, its own search (the bank no longer asks for it). It runs even
  // when the bank failed: the two do not depend on each other.
  const afisha = await generateAfishaIfFriday();
  if (afisha.ran) {
    console.log(`Afisha generated: ${afisha.savedCount} events in ${afisha.cities} cities`);
  }
  process.exit(error ? 1 : 0);
})();
