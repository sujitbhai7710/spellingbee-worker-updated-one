/**
 * Spelling Bee API Worker
 * This Cloudflare Worker provides access to Spelling Bee puzzle data
 */

// Define CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Create the router
class Router {
  constructor() {
    this.routes = [];
  }

  get(pattern, handler) {
    this.routes.push({ method: 'GET', pattern, handler });
    return this;
  }

  async handle(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Handle OPTIONS request for CORS
    if (method === 'OPTIONS') {
      return new Response(null, {
        headers: corsHeaders,
      });
    }

    // Find matching route
    for (const route of this.routes) {
      if (route.method === method) {
        const match = path.match(new RegExp(`^${route.pattern}$`));
        if (match) {
          const params = match.slice(1);
          return await route.handler(request, env, params, ctx);
        }
      }
    }

    // No route matched
    return new Response('Not found', { status: 404 });
  }
}

// Helper function for JSON responses
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  });
}

// Authentication helper function
function isAuthenticated(request, env) {
  const url = new URL(request.url);
  const apiKey = url.searchParams.get('key');

  // Check if the API key is valid
  return apiKey === env.APIKEY;
}

// Direct parser for the exact format provided by NYT
function parseNYTGameData(html) {
  try {
    // Look for the script tag with gameData
    const regex = /<script type="text\/javascript">window\.gameData = ({.*?}),?<\/script>/s;
    const match = html.match(regex);

    if (match && match[1]) {
      const gameDataStr = match[1];
      // Parse the data and extract today's puzzle
      const gameData = JSON.parse(gameDataStr);
      if (gameData && gameData.today) {
        return gameData.today;
      }
    }

    // If the specific format doesn't match, try a more generic approach
    const genericMatch = html.match(/window\.gameData\s*=\s*({.*?});/s);
    if (genericMatch && genericMatch[1]) {
      try {
        const gameData = JSON.parse(genericMatch[1]);
        if (gameData && gameData.today) {
          return gameData.today;
        }
      } catch (e) {
        console.error("Failed to parse generic match:", e);
      }
    }

    return null;
  } catch (error) {
    console.error('Error parsing NYT game data:', error);
    return null;
  }
}

// Scraper functions for NYT Spelling Bee
async function scrapeNYTSpellingBee(env) {
  try {
    // Fetch the NYT Spelling Bee page with cache-busting headers
    // Adding a timestamp to the URL and relevant headers to prevent caching
    const timestamp = Date.now();
    const response = await fetch(`https://www.nytimes.com/puzzles/spelling-bee?t=${timestamp}`, {
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch NYT page: ${response.status}`);
    }

    const html = await response.text();

    // Try to parse using our specialized parser
    const puzzleData = parseNYTGameData(html);

    if (!puzzleData) {
      // Fall back to direct extraction from html if provided in the example format
      const hardcodedMatch = html.match(/<script type="text\/javascript">window\.gameData = (\{"today":.*?\})<\/script>/s);
      if (hardcodedMatch && hardcodedMatch[1]) {
        try {
          const gameData = JSON.parse(hardcodedMatch[1]);
          return gameData.today;
        } catch (error) {
          console.error("Failed to parse hardcoded match:", error);
        }
      }

      throw new Error('Failed to extract puzzle data from NYT page');
    }

    return puzzleData;
  } catch (error) {
    console.error('Error scraping NYT Spelling Bee:', error);
    throw error;
  }
}

// Parser for SBSolver.com puzzles
// Parser for SBSolver.com puzzles
// Parser for SBSolver.com puzzles
function parseSBSolverGameData(html) {
  try {
    const data = {};

    // Extract Date - capture everything until invalid end tag, then strip HTML
    // We remove <a and <br from the stop list so we capture the link content if present
    const dateMatch = html.match(/Spelling Bee for\s+(.*?)(?:<\/span>|<\/h\d>)/i) ||
      html.match(/<span class="bee-date[^>]*">Spelling Bee for (.*?)<\/span>/i);

    let dateRaw = dateMatch ? dateMatch[1] : "Unknown Date";
    // Clean up any remaining HTML tags (like <a>...</a>) or extra whitespace
    data.printDate = dateRaw.replace(/<[^>]*>/g, '').trim();

    // Extract Letters and Center Letter from input field
    const inputMatch = html.match(/<input[^>]*id="string"[^>]*value="([^"]*)"/) ||
      html.match(/value="([^"]*)"[^>]*id="string"/);

    if (inputMatch && inputMatch[1]) {
      const lettersStr = inputMatch[1];
      let center = "";
      let all = [];
      for (const char of lettersStr) {
        if (/[a-zA-Z]/.test(char)) {
          if (char === char.toUpperCase()) center = char.toUpperCase();
          all.push(char.toUpperCase());
        }
      }
      data.centerLetter = center;
      data.validLetters = all;
    }

    // Extract All Answers and detect pangrams
    const answers = [];
    const pangrams = [];

    // Look for words in the table.bee-set
    const tableMatch = html.match(/<table[^>]*class="[^"]*bee-set[^"]*"[^>]*>(.*?)<\/table>/s);

    if (tableMatch) {
      const tableContent = tableMatch[1];
      const trMatches = tableContent.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs);

      for (const trMatch of trMatches) {
        const trHtml = trMatch[1];

        // Check if this row is a pangram (look for 'pangram' text in row)
        const isPangram = /pangram/i.test(trHtml);

        // Find the word in the row
        // Words now often contain spans for center letter: <a ...>AC<span class="bee-center">H</span>E</a>
        // So we capture (.*?) instead of ([^<]*)
        const wordMatch = trHtml.match(/<td class="bee-hover">\s*<a[^>]*>(.*?)<\/a>/i);

        if (wordMatch) {
          // Strip tags from the captured word string (removes <span...>)
          const rawWord = wordMatch[1];
          const cleanWord = rawWord.replace(/<[^>]*>/g, '').trim().toLowerCase();

          if (cleanWord.length >= 4) {
            answers.push(cleanWord);
            if (isPangram) {
              pangrams.push(cleanWord);
            }
          }
        }
      }
    } else {
      // Fallback: look for any valid looking word links if table structure isn't as expected, 
      const allLinks = html.matchAll(/<td class="bee-hover">\s*<a[^>]*>(.*?)<\/a>/gi);
      for (const match of allLinks) {
        const rawWord = match[1];
        const cleanWord = rawWord.replace(/<[^>]*>/g, '').trim().toLowerCase();

        if (cleanWord.length >= 4 && /^[a-z]+$/.test(cleanWord)) {
          answers.push(cleanWord);
          if (data.validLetters && data.validLetters.every(l => cleanWord.toUpperCase().includes(l))) {
            pangrams.push(cleanWord);
          }
        }
      }
    }

    data.pangrams = [...new Set(pangrams)];
    data.answers = [...new Set(answers)]; // Remove duplicates

    if (!data.centerLetter || !data.answers || data.answers.length === 0) {
      console.error(`Incomplete data extracted for SBSolver: Center='${data.centerLetter}', Words=${data.answers?.length || 0}`);
      return null;
    }

    return data;
  } catch (error) {
    console.error('Error parsing SBSolver game data:', error);
    return null;
  }
}

// Store puzzle data in the database using the format from our existing database
async function storePuzzleData(env, puzzleData) {
  try {
    // Get the next puzzle ID by finding the highest existing ID and incrementing
    const getLastPuzzleStmt = env.DB.prepare(`
      SELECT MAX(puzzle_id) as last_id FROM puzzles
    `);

    const lastPuzzleResult = await getLastPuzzleStmt.first();
    const nextPuzzleId = lastPuzzleResult && lastPuzzleResult.last_id ? lastPuzzleResult.last_id + 1 : 2567;

    // Format the date to be consistent with existing data (Month Day, Year)
    let date = puzzleData.printDate;

    // Check if date is in ISO format (YYYY-MM-DD) and convert if necessary
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const parts = date.split('-');
      // Use UTC to avoid timezone shifts when formatting
      const dateObj = new Date(Date.UTC(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2])));
      const options = { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' };
      date = dateObj.toLocaleDateString('en-US', options);
    }

    // Prepare other data
    const centerLetter = puzzleData.centerLetter.toUpperCase();

    // Make sure outerLetters is an array before joining
    let outerLetters = "";
    if (Array.isArray(puzzleData.outerLetters)) {
      outerLetters = puzzleData.outerLetters.join('').toUpperCase();
    } else if (typeof puzzleData.outerLetters === 'string') {
      outerLetters = puzzleData.outerLetters.toUpperCase();
    }

    // Make sure allLetters is an array before joining
    let allLetters = "";
    if (Array.isArray(puzzleData.validLetters)) {
      allLetters = puzzleData.validLetters.join('').toUpperCase();
    } else if (typeof puzzleData.validLetters === 'string') {
      allLetters = puzzleData.validLetters.toUpperCase();
    }

    // Sort letters alphabetically for consistent duplicate checking
    const sortedLetters = allLetters.split('').sort().join('');

    // Check if a puzzle for this date already exists
    const checkDateStmt = env.DB.prepare(`
      SELECT puzzle_id FROM puzzles WHERE date = ?
    `).bind(date);

    const existingPuzzleDate = await checkDateStmt.first();
    if (existingPuzzleDate) {
      return {
        success: false,
        message: `A puzzle for ${date} already exists with ID #${existingPuzzleDate.puzzle_id}`
      };
    }

    // CRITICAL: Check if this letter combination already exists in the database
    // This prevents storing the same puzzle twice even if the date is different
    const checkLettersStmt = env.DB.prepare(`
      SELECT puzzle_id, date FROM puzzles 
      WHERE letters = ? AND all_letters = ?
    `).bind(centerLetter, allLetters);

    const existingLetters = await checkLettersStmt.first();
    if (existingLetters) {
      return {
        success: false,
        message: `This exact puzzle (Center: ${centerLetter}, All: ${allLetters}) was already stored for ${existingLetters.date} (ID #${existingLetters.puzzle_id}). Skipping duplicate.`
      };
    }

    const wordCount = puzzleData.answers ? puzzleData.answers.length : 0;
    const pangramsCount = puzzleData.pangrams ? puzzleData.pangrams.length : 0;

    // Insert puzzle data - Fix schema to match the database (removed outer_letters column)
    const insertPuzzleStmt = env.DB.prepare(`
      INSERT INTO puzzles (puzzle_id, date, letters, all_letters, word_count, pangrams_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      nextPuzzleId, // Use our calculated ID instead of puzzleData.id
      date,
      centerLetter,
      allLetters,
      wordCount,
      pangramsCount
    );

    await insertPuzzleStmt.run();

    // Insert words
    const insertedWords = [];

    if (Array.isArray(puzzleData.answers)) {
      for (const word of puzzleData.answers) {
        // Check if the word is a pangram
        const isPangram = Array.isArray(puzzleData.pangrams) && puzzleData.pangrams.includes(word) ? 1 : 0;
        const length = word.length;

        const insertWordStmt = env.DB.prepare(`
          INSERT INTO words (puzzle_id, word, is_pangram, length)
          VALUES (?, ?, ?, ?)
        `).bind(
          nextPuzzleId, // Use our calculated ID instead of puzzleData.id
          word.toLowerCase(), // Store words in lowercase for consistency
          isPangram,
          length
        );

        await insertWordStmt.run();
        insertedWords.push(word);
      }
    }

    return {
      success: true,
      puzzleId: nextPuzzleId,
      originalId: puzzleData.id,
      date,
      centerLetter,
      outerLetters: outerLetters, // Still include this in the response
      allLetters,
      wordCount,
      pangramsCount,
      wordsInserted: insertedWords.length
    };
  } catch (error) {
    console.error('Error storing puzzle data:', error);
    throw error;
  }
}

// Helper function to calculate puzzle enrichments (points, perfect pangrams)
function calculatePuzzleEnrichments(words) {
  let totalPoints = 0;
  const perfectPangrams = [];
  let hasPerfectPangram = false;

  if (Array.isArray(words)) {
    words.forEach(wordObj => {
      const { word, is_pangram, length } = wordObj;
      if (length === 4) {
        totalPoints += 1;
      } else if (length > 4) {
        totalPoints += length;
      }
      if (is_pangram) {
        totalPoints += 7; // Bonus for pangram
        if (length === 7) {
          hasPerfectPangram = true;
          perfectPangrams.push(word);
        }
      }
    });
  }

  return {
    totalPoints,
    hasPerfectPangram,
    perfectPangrams,
  };
}

// Helper function to get today's puzzle data from the database
async function getTodayPuzzleData(env) {
  // Fetch ALL puzzles (just metadata needed for sorting) to ensure we find the true latest date
  // Ordering by ID is unreliable as shown by user data (ID 2684 is newer than ID 2756)
  const puzzleIdsStmt = env.DB.prepare(`
    SELECT puzzle_id, date FROM puzzles
  `);

  const idResult = await puzzleIdsStmt.all();
  const allPuzzles = idResult.results || [];

  if (allPuzzles.length === 0) {
    return null;
  }

  // Sort by date descending
  allPuzzles.sort((a, b) => new Date(b.date) - new Date(a.date));

  // The latest puzzle by date
  const latestId = allPuzzles[0].puzzle_id;

  // Get full puzzle details for the target ID
  const puzzleStmt = env.DB.prepare(`
    SELECT * FROM puzzles WHERE puzzle_id = ?
  `).bind(latestId);
  const puzzleResult = await puzzleStmt.first();

  // Get words for this puzzle
  const wordsStmt = env.DB.prepare(`
    SELECT word, is_pangram, length FROM words 
    WHERE puzzle_id = ?
    ORDER BY is_pangram DESC, length DESC, word
  `).bind(latestId);

  const wordsResult = await wordsStmt.all();
  const words = wordsResult.results || [];

  const enrichments = calculatePuzzleEnrichments(words);

  return {
    puzzle: puzzleResult,
    words: words,
    totalPoints: enrichments.totalPoints,
    hasPerfectPangram: enrichments.hasPerfectPangram,
    perfectPangrams: enrichments.perfectPangrams,
  };
}

// Helper function to commit today's puzzle data to GitHub
async function commitToGithub(env, puzzleData) {
  try {
    const owner = '0xSatwik';
    const repo = 'spellingbee-solver';
    const path = 'public/today.json';
    const token = env.GITHUB_TOKEN;

    if (!token) {
      console.error('GITHUB_TOKEN not found in environment');
      return;
    }

    // Prepare the content
    const content = btoa(JSON.stringify(puzzleData, null, 2));

    // Get the SHA of the existing file (if it exists)
    let sha;
    const getFileResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'Cloudflare-Worker'
      }
    });

    if (getFileResponse.ok) {
      const fileData = await getFileResponse.json();
      sha = fileData.sha;
    }

    // Commit the file
    const commitResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
      method: 'PUT',
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'Cloudflare-Worker',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: `Sync today's puzzle: ${puzzleData.puzzle.date}`,
        content: content,
        sha: sha
      })
    });

    if (!commitResponse.ok) {
      const errorData = await commitResponse.json();
      console.error('GitHub Commit Error:', errorData);
      throw new Error(`GitHub commit failed: ${commitResponse.statusText}`);
    }

    console.log('Successfully committed today.json to GitHub');
  } catch (error) {
    console.error('Error committing to GitHub:', error);
  }
}

// Helper function to format date as "january-27-2026"
function formatDateForURL(date) {
  const months = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december'
  ];
  const month = months[date.getMonth()];
  const day = date.getDate();
  const year = date.getFullYear();
  return `${month}-${day}-${year}`;
}

// Helper function to generate date array for last N days
function getLastNDays(n) {
  const dates = [];
  const today = new Date();
  for (let i = 0; i < n; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() - i);
    dates.push(date);
  }
  return dates;
}

// Helper function to generate sitemap XML
function generateSitemap() {
  const baseUrl = 'https://sbsolver.online';
  const now = new Date().toISOString();

  // Define static routes with their priorities and change frequencies
  const staticRoutes = [
    { path: '/', priority: '1.0', changefreq: 'daily' },
    { path: '/today', priority: '1.0', changefreq: 'daily' },
    { path: '/solver', priority: '1.0', changefreq: 'weekly' },
    { path: '/yesterday', priority: '0.9', changefreq: 'daily' },
    { path: '/archive', priority: '0.8', changefreq: 'weekly' },
    { path: '/stats', priority: '0.8', changefreq: 'weekly' },
    { path: '/articles', priority: '0.7', changefreq: 'weekly' },
    { path: '/about', priority: '0.5', changefreq: 'monthly' },
    { path: '/contact', priority: '0.5', changefreq: 'monthly' },
    { path: '/privacy', priority: '0.5', changefreq: 'monthly' },
  ];

  // Generate dynamic answer pages for last 100 days
  const last100Days = getLastNDays(100);
  const dynamicRoutes = last100Days.map((date, index) => {
    let priority = '0.7'; // Default for older answers
    if (index === 0) {
      priority = '1.0'; // Today's answer
    } else if (index < 7) {
      priority = '0.9'; // Last week
    }

    return {
      path: `/answer-for-${formatDateForURL(date)}`,
      priority,
      changefreq: 'daily',
      lastmod: index === 0 ? now : date.toISOString()
    };
  });

  // Combine all routes
  const allRoutes = [...staticRoutes, ...dynamicRoutes];

  // Build XML
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

  for (const route of allRoutes) {
    xml += '  <url>\n';
    xml += `    <loc>${baseUrl}${route.path}</loc>\n`;
    xml += `    <lastmod>${route.lastmod || now}</lastmod>\n`;
    xml += `    <changefreq>${route.changefreq}</changefreq>\n`;
    xml += `    <priority>${route.priority}</priority>\n`;
    xml += '  </url>\n';
  }

  xml += '</urlset>';
  return xml;
}

// Helper function to generate RSS feed
function generateRSSFeed() {
  const baseUrl = 'https://sbsolver.online';
  const now = new Date();

  // Get last 20 days for feed items
  const last20Days = getLastNDays(20);

  // Build RSS 2.0 XML
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n';
  xml += '  <channel>\n';
  xml += '    <title>Spelling Bee Solver - Daily Answers</title>\n';
  xml += '    <link>https://sbsolver.online</link>\n';
  xml += '    <description>Daily NYT Spelling Bee puzzle answers and solutions</description>\n';
  xml += '    <language>en-us</language>\n';
  xml += `    <lastBuildDate>${now.toUTCString()}</lastBuildDate>\n`;
  xml += '    <atom:link href="https://sbsolver.online/feed.xml" rel="self" type="application/rss+xml" />\n';

  for (const date of last20Days) {
    const urlDate = formatDateForURL(date);
    const displayDate = date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    xml += '    <item>\n';
    xml += `      <title>Spelling Bee Answer for ${displayDate}</title>\n`;
    xml += `      <link>${baseUrl}/answer-for-${urlDate}</link>\n`;
    xml += `      <description>Find the complete solution and word list for NYT Spelling Bee puzzle on ${displayDate}</description>\n`;
    xml += `      <pubDate>${date.toUTCString()}</pubDate>\n`;
    xml += `      <guid isPermaLink="true">${baseUrl}/answer-for-${urlDate}</guid>\n`;
    xml += '    </item>\n';
  }

  xml += '  </channel>\n';
  xml += '</rss>';
  return xml;
}

// Create the router instance
const router = new Router();

// Sitemap endpoint
router.get('/sitemap.xml', async (request, env) => {
  const sitemap = generateSitemap();
  return new Response(sitemap, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
      ...corsHeaders,
    },
  });
});

// RSS Feed endpoint
router.get('/feed.xml', async (request, env) => {
  const feed = generateRSSFeed();
  return new Response(feed, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
      ...corsHeaders,
    },
  });
});

// Root endpoint - API info
router.get('/', async (request, env) => {
  return jsonResponse({
    name: 'Spelling Bee API',
    version: '1.0.0',
    endpoints: [
      '/api/puzzles',
      '/api/puzzle/:id',
      '/api/mostCommonCenterLetters',
      '/api/puzzlesWithMostWords',
      '/api/puzzlesWithMostPangrams',
      '/api/allLettersFrequency',
      '/api/longestPangrams',
      '/api/search/date/:query',
      '/api/search/letter/:letter',
      '/api/search/id/:id',
      '/api/statistics',
      '/api/last/:count',
      '/api/searchWordle/:center_letter',
      '/api/update/nyt',
      '/api/delete/:id',
      '/today',      // Today's puzzle
      '/yesterday',   // Yesterday's puzzle
      '/sitemap.xml', // Dynamic sitemap
      '/feed.xml'     // RSS feed
    ],
  });
});

// Get all puzzles with pagination
router.get('/api/puzzles', async (request, env) => {
  const url = new URL(request.url);
  const limit = parseInt(url.searchParams.get('limit') || '50');
  const offset = parseInt(url.searchParams.get('offset') || '0');

  const stmt = env.DB.prepare(`
    SELECT puzzle_id, date, letters, all_letters, word_count, pangrams_count 
    FROM puzzles 
    ORDER BY puzzle_id DESC
    LIMIT ? OFFSET ?
  `).bind(limit, offset);

  const result = await stmt.all();

  return jsonResponse({
    puzzles: result.results,
    pagination: {
      limit,
      offset,
    }
  });
});

// Get chronological list of puzzles (latest to oldest) with strict pagination
router.get('/api/puzzles/list', async (request, env) => {
  const url = new URL(request.url);
  let limit = parseInt(url.searchParams.get('limit') || '20');
  const page = parseInt(url.searchParams.get('page') || '1');

  // Enforce max limit of 20
  if (limit > 20) limit = 20;
  if (limit < 1) limit = 20; // Default if invalid

  // Calculate offset
  const offset = (page - 1) * limit;

  // Fetch ALL puzzles metadata
  const stmt = env.DB.prepare(`
    SELECT puzzle_id, date, letters, all_letters, word_count, pangrams_count 
    FROM puzzles
  `);

  const result = await stmt.all();
  const allPuzzles = result.results || [];

  // Sort by date descending (Latest to Oldest)
  allPuzzles.sort((a, b) => new Date(b.date) - new Date(a.date));

  // Slice for pagination
  const paginatedPuzzles = allPuzzles.slice(offset, offset + limit);

  return jsonResponse({
    puzzles: paginatedPuzzles,
    pagination: {
      page: page,
      limit: limit,
      total_items: allPuzzles.length,
      total_pages: Math.ceil(allPuzzles.length / limit)
    }
  });
});

// Get puzzle by ID with words
router.get('/api/puzzle/([0-9]+)', async (request, env, params) => {
  const puzzleId = parseInt(params[0]);

  // Get puzzle details
  const puzzleStmt = env.DB.prepare(`
    SELECT * FROM puzzles WHERE puzzle_id = ?
  `).bind(puzzleId);

  const puzzleResult = await puzzleStmt.first();

  if (!puzzleResult) {
    return jsonResponse({ error: `Puzzle #${puzzleId} not found` }, 404);
  }

  // Get words for this puzzle
  const wordsStmt = env.DB.prepare(`
    SELECT word, is_pangram, length FROM words 
    WHERE puzzle_id = ?
    ORDER BY is_pangram DESC, length DESC, word
  `).bind(puzzleId);

  const wordsResult = await wordsStmt.all();
  const words = wordsResult.results || [];

  const enrichments = calculatePuzzleEnrichments(words);

  return jsonResponse({
    puzzle: puzzleResult,
    words: words,
    totalPoints: enrichments.totalPoints,
    hasPerfectPangram: enrichments.hasPerfectPangram,
    perfectPangrams: enrichments.perfectPangrams,
  });
});

// Most Common Center Letters
router.get('/api/mostCommonCenterLetters', async (request, env) => {
  const stmt = env.DB.prepare(`
    SELECT letters, COUNT(*) as count 
    FROM puzzles 
    GROUP BY letters 
    ORDER BY count DESC
    LIMIT 26
  `);

  const result = await stmt.all();

  return jsonResponse({
    centerLetterFrequency: result.results,
  });
});

// Puzzles with Most Words
router.get('/api/puzzlesWithMostWords', async (request, env) => {
  const limit = 10;

  const stmt = env.DB.prepare(`
    SELECT puzzle_id, date, word_count
    FROM puzzles
    ORDER BY word_count DESC
    LIMIT ?
  `).bind(limit);

  const result = await stmt.all();

  return jsonResponse({
    puzzlesWithMostWords: result.results,
  });
});

// Puzzles with Most Pangrams
router.get('/api/puzzlesWithMostPangrams', async (request, env) => {
  const limit = 10;

  const stmt = env.DB.prepare(`
    SELECT puzzle_id, date, pangrams_count
    FROM puzzles
    ORDER BY pangrams_count DESC
    LIMIT ?
  `).bind(limit);

  const result = await stmt.all();

  return jsonResponse({
    puzzlesWithMostPangrams: result.results,
  });
});

// All Letters Frequency
router.get('/api/allLettersFrequency', async (request, env) => {
  // Get all puzzles with their letters
  const stmt = env.DB.prepare(`
    SELECT all_letters FROM puzzles
  `);

  const result = await stmt.all();
  const puzzles = result.results;

  // Process the letters in JavaScript instead of using WITH clause
  const letterCounts = {};

  // Count each letter's frequency
  for (const puzzle of puzzles) {
    if (puzzle.all_letters) {
      for (let i = 0; i < puzzle.all_letters.length; i++) {
        const letter = puzzle.all_letters[i].toUpperCase();
        letterCounts[letter] = (letterCounts[letter] || 0) + 1;
      }
    }
  }

  // Convert to array and sort
  const letterFrequency = Object.keys(letterCounts).map(letter => ({
    letter: letter,
    count: letterCounts[letter]
  })).sort((a, b) => b.count - a.count);

  return jsonResponse({
    allLettersFrequency: letterFrequency,
  });
});

// Longest Pangrams
router.get('/api/longestPangrams', async (request, env) => {
  const limit = 10;

  const stmt = env.DB.prepare(`
    SELECT w.word, p.puzzle_id, p.date, LENGTH(w.word) as len
    FROM words w
    JOIN puzzles p ON w.puzzle_id = p.puzzle_id
    WHERE w.is_pangram = 1
    ORDER BY len DESC
    LIMIT ?
  `).bind(limit);

  const result = await stmt.all();

  return jsonResponse({
    longestPangrams: result.results,
  });
});

// Search by Date
router.get('/api/search/date/([^/]+)', async (request, env, params) => {
  const dateQuery = params[0];

  // Handle different date formats for searching
  let formattedQuery = dateQuery;
  let dateObj;

  // Try to parse the date query
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateQuery)) {
    // If ISO format (YYYY-MM-DD), convert to a Date object
    dateObj = new Date(dateQuery);
    if (!isNaN(dateObj.getTime())) {
      // Format for human-readable search
      const options = { year: 'numeric', month: 'long', day: 'numeric' };
      formattedQuery = dateObj.toLocaleDateString('en-US', options);
    }
  } else if (/^\d{4}-\d{2}$/.test(dateQuery)) {
    // If year-month format, search for that month
    const [year, month] = dateQuery.split('-');
    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];
    if (month >= 1 && month <= 12) {
      formattedQuery = `${monthNames[parseInt(month) - 1]} %, ${year}`;
    }
  } else if (/^\d{4}$/.test(dateQuery)) {
    // If just year, search for that year
    formattedQuery = `%, ${dateQuery}`;
  }

  // Use multiple LIKE clauses to increase chance of matches
  const stmt = env.DB.prepare(`
    SELECT puzzle_id, date, letters, all_letters, word_count, pangrams_count 
    FROM puzzles 
    WHERE date LIKE ? OR date LIKE ? OR date LIKE ?
    ORDER BY puzzle_id DESC
  `).bind(`%${dateQuery}%`, `%${formattedQuery}%`, `%${dateQuery.replace(/-/g, ' ')}%`);

  const result = await stmt.all();
  const puzzles = result.results;

  // Get words for each puzzle
  const puzzlesWithWords = [];

  for (const puzzle of puzzles) {
    const wordsStmt = env.DB.prepare(`
      SELECT word, is_pangram, length 
      FROM words 
      WHERE puzzle_id = ?
      ORDER BY is_pangram DESC, length DESC, word
    `).bind(puzzle.puzzle_id);

    const wordsResult = await wordsStmt.all();
    const words = wordsResult.results || [];
    const enrichments = calculatePuzzleEnrichments(words);

    puzzlesWithWords.push({
      puzzle: puzzle,
      words: words,
      totalPoints: enrichments.totalPoints,
      hasPerfectPangram: enrichments.hasPerfectPangram,
      perfectPangrams: enrichments.perfectPangrams,
    });
  }

  return jsonResponse({
    query: dateQuery,
    formattedQuery,
    results: puzzlesWithWords
  });
});

// Search by Letter
router.get('/api/search/letter/([A-Za-z])', async (request, env, params) => {
  const letter = params[0].toUpperCase();
  const url = new URL(request.url);
  const centerOnly = url.searchParams.get('centerOnly') === 'true';

  let stmt;

  if (centerOnly) {
    stmt = env.DB.prepare(`
      SELECT puzzle_id, date, letters, all_letters, word_count 
      FROM puzzles 
      WHERE letters = ? 
      ORDER BY puzzle_id DESC
    `).bind(letter);
  } else {
    stmt = env.DB.prepare(`
      SELECT puzzle_id, date, letters, all_letters, word_count 
      FROM puzzles 
      WHERE all_letters LIKE ? 
      ORDER BY puzzle_id DESC
    `).bind(`%${letter}%`);
  }

  const result = await stmt.all();

  return jsonResponse({
    letter,
    centerOnly,
    results: result.results,
  });
});

// NEW ENDPOINTS

// Search by ID
router.get('/api/search/id/([0-9]+)', async (request, env, params) => {
  const puzzleId = parseInt(params[0]);

  const stmt = env.DB.prepare(`
    SELECT puzzle_id, date, letters, all_letters, word_count, pangrams_count 
    FROM puzzles 
    WHERE puzzle_id = ? 
  `).bind(puzzleId);

  const result = await stmt.first();

  if (!result) {
    return jsonResponse({ error: `Puzzle #${puzzleId} not found` }, 404);
  }

  return jsonResponse({
    result
  });
});

// Search Wordle using Spelling Bee puzzle center letter
router.get('/api/searchWordle/([A-Za-z])', async (request, env, params) => {
  const centerLetter = params[0].toUpperCase();

  // Find words that could be wordle answers containing the center letter
  const stmt = env.DB.prepare(`
    SELECT DISTINCT w.word
    FROM words w
    JOIN puzzles p ON w.puzzle_id = p.puzzle_id
    WHERE w.length = 5 
    AND w.word LIKE ?
    AND NOT w.is_pangram 
    ORDER BY w.word
  `).bind(`%${centerLetter}%`);

  const result = await stmt.all();

  return jsonResponse({
    centerLetter,
    possibleWordleWords: result.results,
  });
});

// Spelling Bee Statistics
router.get('/api/statistics', async (request, env) => {
  // Get total puzzles count
  const puzzleCountStmt = env.DB.prepare(`SELECT COUNT(*) as total FROM puzzles`);
  const puzzleCount = await puzzleCountStmt.first();

  // Get total words count
  const wordCountStmt = env.DB.prepare(`SELECT COUNT(*) as total FROM words`);
  const wordCount = await wordCountStmt.first();

  // Get total pangrams count
  const pangramCountStmt = env.DB.prepare(`SELECT COUNT(*) as total FROM words WHERE is_pangram = 1`);
  const pangramCount = await pangramCountStmt.first();

  // Get average words per puzzle
  const avgWordsStmt = env.DB.prepare(`SELECT AVG(word_count) as avg FROM puzzles`);
  const avgWords = await avgWordsStmt.first();

  // Get average pangrams per puzzle
  const avgPangramsStmt = env.DB.prepare(`SELECT AVG(pangrams_count) as avg FROM puzzles`);
  const avgPangrams = await avgPangramsStmt.first();

  // Get highest word count
  const maxWordsStmt = env.DB.prepare(`
    SELECT puzzle_id, date, word_count 
    FROM puzzles 
    ORDER BY word_count DESC 
    LIMIT 1
  `);
  const maxWords = await maxWordsStmt.first();

  // Get lowest word count
  const minWordsStmt = env.DB.prepare(`
    SELECT puzzle_id, date, word_count 
    FROM puzzles 
    ORDER BY word_count ASC 
    LIMIT 1
  `);
  const minWords = await minWordsStmt.first();

  return jsonResponse({
    totalPuzzles: puzzleCount?.total || 0,
    totalWords: wordCount?.total || 0,
    totalPangrams: pangramCount?.total || 0,
    averageWordsPerPuzzle: avgWords?.avg || 0,
    averagePangramsPerPuzzle: avgPangrams?.avg || 0,
    puzzleWithMostWords: maxWords,
    puzzleWithFewestWords: minWords
  });
});

// Get last N puzzles with details
router.get('/api/last/([0-9]+)', async (request, env, params) => {
  const count = parseInt(params[0]);

  // Validate count
  if (count <= 0 || count > 100) {
    return jsonResponse({
      error: "Count must be between 1 and 100"
    }, 400);
  }

  // Get the last N puzzles
  const puzzlesStmt = env.DB.prepare(`
    SELECT puzzle_id, date, letters, all_letters, word_count, pangrams_count 
    FROM puzzles 
    ORDER BY puzzle_id DESC
    LIMIT ?
  `).bind(count);

  const puzzlesResult = await puzzlesStmt.all();
  const puzzles = puzzlesResult.results;

  // Get words for each puzzle
  const puzzlesWithWords = [];

  for (const puzzle of puzzles) {
    const wordsStmt = env.DB.prepare(`
      SELECT word, is_pangram, length 
      FROM words 
      WHERE puzzle_id = ?
      ORDER BY is_pangram DESC, length DESC, word
    `).bind(puzzle.puzzle_id);

    const wordsResult = await wordsStmt.all();
    const words = wordsResult.results || [];
    const enrichments = calculatePuzzleEnrichments(words);

    puzzlesWithWords.push({
      ...puzzle,
      words: words,
      totalPoints: enrichments.totalPoints,
      hasPerfectPangram: enrichments.hasPerfectPangram,
      perfectPangrams: enrichments.perfectPangrams,
    });
  }

  return jsonResponse({
    count,
    puzzles: puzzlesWithWords
  });
});

// Manual update endpoint - trigger scraping manually with authentication
router.get('/api/update/nyt', async (request, env, params, ctx) => {
  // Check authentication
  if (!isAuthenticated(request, env)) {
    return jsonResponse({
      success: false,
      error: 'Unauthorized access. Valid API key is required.'
    }, 401);
  }

  try {
    const puzzleData = await scrapeNYTSpellingBee(env);

    const result = await storePuzzleData(env, puzzleData);

    // After storing, sync to GitHub for high traffic support
    const todayData = await getTodayPuzzleData(env);
    if (todayData) {
      ctx.waitUntil(commitToGithub(env, todayData));
    }

    return jsonResponse(result);
  } catch (error) {
    return jsonResponse({
      success: false,
      error: error.message
    }, 500);
  }
});

// Delete a puzzle by ID with authentication
router.get('/api/delete/([0-9]+)', async (request, env, params) => {
  // Check authentication
  if (!isAuthenticated(request, env)) {
    return jsonResponse({
      success: false,
      error: 'Unauthorized access. Valid API key is required.'
    }, 401);
  }

  try {
    const puzzleId = parseInt(params[0]);

    // First check if the puzzle exists
    const checkStmt = env.DB.prepare(`
      SELECT puzzle_id FROM puzzles WHERE puzzle_id = ?
    `).bind(puzzleId);

    const existingPuzzle = await checkStmt.first();
    if (!existingPuzzle) {
      return jsonResponse({
        success: false,
        message: `Puzzle #${puzzleId} does not exist`
      }, 404);
    }

    // Delete associated words first (foreign key constraint)
    const deleteWordsStmt = env.DB.prepare(`
      DELETE FROM words WHERE puzzle_id = ?
    `).bind(puzzleId);

    await deleteWordsStmt.run();

    // Then delete the puzzle
    const deletePuzzleStmt = env.DB.prepare(`
      DELETE FROM puzzles WHERE puzzle_id = ?
    `).bind(puzzleId);

    await deletePuzzleStmt.run();

    return jsonResponse({
      success: true,
      message: `Puzzle #${puzzleId} and all its words have been deleted`,
      puzzleId
    });
  } catch (error) {
    console.error('Error deleting puzzle:', error);
    return jsonResponse({
      success: false,
      error: error.message
    }, 500);
  }
});

// Delete a puzzle by date with authentication
router.get('/api/delete/date/(.+)', async (request, env, params) => {
  // Check authentication
  if (!isAuthenticated(request, env)) {
    return jsonResponse({
      success: false,
      error: 'Unauthorized access. Valid API key is required.'
    }, 401);
  }

  try {
    let dateParam = decodeURIComponent(params[0]);
    let date = dateParam;

    // Normalize date format if it's ISO (YYYY-MM-DD)
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const parts = date.split('-');
      const dateObj = new Date(Date.UTC(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2])));
      const options = { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' };
      date = dateObj.toLocaleDateString('en-US', options);
    }

    // First check if a puzzle for this date exists and get its ID
    const findPuzzleStmt = env.DB.prepare(`
      SELECT puzzle_id FROM puzzles WHERE date = ?
    `).bind(date);

    const puzzleResult = await findPuzzleStmt.first();
    if (!puzzleResult) {
      return jsonResponse({
        success: false,
        message: `No puzzle found for date: ${date}`
      }, 404);
    }

    const puzzleId = puzzleResult.puzzle_id;

    // Delete associated words
    const deleteWordsStmt = env.DB.prepare(`
      DELETE FROM words WHERE puzzle_id = ?
    `).bind(puzzleId);
    await deleteWordsStmt.run();

    // Delete the puzzle
    const deletePuzzleStmt = env.DB.prepare(`
      DELETE FROM puzzles WHERE puzzle_id = ?
    `).bind(puzzleId);
    await deletePuzzleStmt.run();

    return jsonResponse({
      success: true,
      message: `Puzzle for date ${date} (ID #${puzzleId}) has been deleted`,
      puzzleId,
      date
    });
  } catch (error) {
    console.error('Error deleting puzzle by date:', error);
    return jsonResponse({
      success: false,
      error: error.message
    }, 500);
  }
});

// Add a puzzle by scraping SBSolver.com using ID
router.get('/api/add/id/([0-9]+)', async (request, env, params, ctx) => {
  // Check authentication
  if (!isAuthenticated(request, env)) {
    return jsonResponse({
      success: false,
      error: 'Unauthorized access. Valid API key is required.'
    }, 401);
  }

  try {
    const sbsId = params[0];
    const url = `https://www.sbsolver.com/s/${sbsId}`;

    console.log(`Manually adding puzzle from SBSolver ID: ${sbsId}`);

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'python-requests/2.25.1'
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch SBSolver page: ${response.status}`);
    }

    const html = await response.text();
    const puzzleData = parseSBSolverGameData(html);

    if (!puzzleData) {
      throw new Error(`Failed to parse puzzle data from SBSolver ID: ${sbsId}`);
    }

    // Explicitly set the original ID
    puzzleData.id = sbsId;

    const result = await storePuzzleData(env, puzzleData);

    return jsonResponse({
      ...result,
      source: 'SBSolver',
      sourceId: sbsId
    });
  } catch (error) {
    console.error('Error adding puzzle by ID:', error);
    return jsonResponse({
      success: false,
      error: error.message
    }, 500);
  }
});

// Get today's puzzle
router.get('/today', async (request, env) => {
  try {
    const todayData = await getTodayPuzzleData(env);

    if (!todayData) {
      return jsonResponse({ error: 'No puzzles found' }, 404);
    }

    return jsonResponse(todayData);
  } catch (error) {
    console.error('Error fetching today\'s puzzle:', error);
    return jsonResponse({
      success: false,
      error: error.message
    }, 500);
  }
});

// Get yesterday's puzzle
router.get('/yesterday', async (request, env) => {
  try {
    // Fetch ALL puzzles (just metadata needed for sorting) to ensure we find the true yesterday date
    // Ordering by ID is unreliable
    const puzzleIdsStmt = env.DB.prepare(`
      SELECT puzzle_id, date FROM puzzles
    `);

    const idResult = await puzzleIdsStmt.all();
    const allPuzzles = idResult.results || [];

    if (allPuzzles.length < 2) {
      return jsonResponse({ error: 'Yesterday\'s puzzle not found' }, 404);
    }

    // Sort by date descending
    allPuzzles.sort((a, b) => new Date(b.date) - new Date(a.date));

    // The second latest puzzle by date is "yesterday"
    const yesterdayId = allPuzzles[1].puzzle_id;

    // Get full puzzle details for the target ID
    const puzzleStmt = env.DB.prepare(`
      SELECT * FROM puzzles WHERE puzzle_id = ?
    `).bind(yesterdayId);
    const puzzleResult = await puzzleStmt.first();

    if (!puzzleResult) {
      return jsonResponse({ error: 'Yesterday\'s puzzle not found' }, 404);
    }

    // Get words for this puzzle
    const wordsStmt = env.DB.prepare(`
      SELECT word, is_pangram, length FROM words 
      WHERE puzzle_id = ?
      ORDER BY is_pangram DESC, length DESC, word
    `).bind(yesterdayId);

    const wordsResult = await wordsStmt.all();
    const words = wordsResult.results || [];

    const enrichments = calculatePuzzleEnrichments(words);

    return jsonResponse({
      puzzle: puzzleResult,
      words: words,
      totalPoints: enrichments.totalPoints,
      hasPerfectPangram: enrichments.hasPerfectPangram,
      perfectPangrams: enrichments.perfectPangrams,
    });
  } catch (error) {
    console.error('Error fetching yesterday\'s puzzle:', error);
    return jsonResponse({
      success: false,
      error: error.message
    }, 500);
  }
});

// Main fetch handler and scheduled handler
export default {
  // Handle HTTP requests
  async fetch(request, env, ctx) {
    return router.handle(request, env, ctx);
  },

  // Scheduled task - runs at 07:01 UTC and fallback at 07:05 UTC every day
  async scheduled(event, env, ctx) {
    try {
      console.log('Running scheduled NYT Spelling Bee update');

      // Scrape the latest puzzle
      const puzzleData = await scrapeNYTSpellingBee(env);

      // Validate puzzle data has required fields
      if (!puzzleData || !puzzleData.printDate) {
        throw new Error('Invalid puzzle data: Missing date information');
      }

      // Check date format and log it
      console.log(`Raw date from NYT: ${puzzleData.printDate}`);

      const result = await storePuzzleData(env, puzzleData);

      // After storing, sync to GitHub
      const todayData = await getTodayPuzzleData(env);
      if (todayData) {
        ctx.waitUntil(commitToGithub(env, todayData));
      }

      console.log('Scheduled update result:', result);

      return result;
    } catch (error) {
      console.error('Error in scheduled task:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
}; 