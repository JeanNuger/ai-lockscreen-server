require('dotenv').config();

const { generateDailyBank } = require('./dailyContentBank');

(async () => {
  const { savedCount, error } = await generateDailyBank();

  if (error) {
    console.error(`Daily Bank generation failed: ${error}`);
    process.exit(1);
  }

  console.log(`Daily Bank generated successfully: ${savedCount} rows saved`);
  process.exit(0);
})();
