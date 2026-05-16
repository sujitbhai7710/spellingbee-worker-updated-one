# Spelling Bee API Worker

This Cloudflare Worker provides access to a database of New York Times Spelling Bee puzzles.

## API Endpoints

- `/api/puzzles` - Get all puzzles with pagination
- `/api/puzzle/:id` - Get a specific puzzle by ID. Response includes `puzzle` (object), `words` (array), `totalPoints` (number), `hasPerfectPangram` (boolean), and `perfectPangrams` (array of strings).
- `/api/mostCommonCenterLetters` - Get frequency of center letters
- `/api/puzzlesWithMostWords` - Get puzzles with the most words
- `/api/puzzlesWithMostPangrams` - Get puzzles with the most pangrams
- `/api/allLettersFrequency` - Get frequency of all letters in puzzles
- `/api/longestPangrams` - Get the longest pangram words
- `/api/search/date/:query` - Search puzzles by date. Each puzzle in the `results` array will include `puzzle` (object), `words` (array), `totalPoints` (number), `hasPerfectPangram` (boolean), and `perfectPangrams` (array of strings).
- `/api/search/letter/:letter` - Search puzzles by letter
- `/api/search/id/:id` - Search for a specific puzzle by ID
- `/api/statistics` - Get overall statistics about the puzzles
- `/api/last/:count` - Get the last N puzzles. Each puzzle in the `puzzles` array will include `totalPoints` (number), `hasPerfectPangram` (boolean), and `perfectPangrams` (array of strings).
- `/api/searchWordle/:center_letter` - Find potential Wordle answers containing a letter
- `/today` - Get today's puzzle. Response includes `puzzle` (object), `words` (array), `totalPoints` (number), `hasPerfectPangram` (boolean), and `perfectPangrams` (array of strings).
- `/yesterday` - Get yesterday's puzzle. Response includes `puzzle` (object), `words` (array), `totalPoints` (number), `hasPerfectPangram` (boolean), and `perfectPangrams` (array of strings).

## Deployment Steps

### Prerequisites

1. Node.js and npm installed
2. Wrangler CLI installed (`npm install -g wrangler`)
3. Cloudflare account with Workers subscription
4. Python 3.x (for database export)

### Steps to Deploy

1. **Prepare the database**

   ```bash
   # Export the SQLite database to SQL format
   python export_db_to_sql.py
   ```

2. **Create a D1 database in Cloudflare**

   ```bash
   # Login to Cloudflare
   wrangler login

   # Create a new D1 database
   wrangler d1 create spelling-bee-db
   ```

   This will output a database ID. Copy this ID.

3. **Update wrangler.toml with your database ID**

   Edit `wrangler.toml` and replace `UPDATE_WITH_ACTUAL_DATABASE_ID` with the database ID.

4. **Create database tables and import data**

   ```bash
   # Apply the schema
   wrangler d1 execute spelling-bee-db --file=schema.sql

   # Import the data (may take some time)
   wrangler d1 execute spelling-bee-db --file=spelling_bee_data.sql
   ```

5. **Deploy the worker**

   ```bash
   # Deploy to Cloudflare Workers
   wrangler deploy
   ```

6. **Test the API**

   Visit the domain shown in the deployment output to test your API.

## Local Development

To run the worker locally:

```bash
wrangler dev
```

## Troubleshooting

- If you have authentication issues, try running `wrangler logout` and then `wrangler login` again.
- For large databases, you may need to split the SQL file into smaller chunks if you encounter timeouts.
- Check Cloudflare Workers logs for any runtime errors.

## License

MIT 