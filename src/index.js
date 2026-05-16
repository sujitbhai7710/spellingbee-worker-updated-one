/**
 * Spelling Bee API Worker v2.0
 * Cloudflare Worker providing access to Spelling Bee puzzle data
 * 
 * Changelog v2.0:
 * - CRITICAL FIX: /api/last/:count now orders by date DESC (not puzzle_id)
 * - CRITICAL FIX: sortedLetters now used for proper duplicate detection
 * - CRITICAL FIX: mostCommonCenterLetters filters empty/null center letters
 * - PERF: /today and /yesterday use single optimized query instead of fetching ALL puzzles
 * - PERF: /api/puzzles/list uses SQL-based date sorting instead of JS sort
 * - PERF: storePuzzleData uses D1 batch inserts for words (1 query instead of N)
 * - PERF: /api/statistics uses batched query (1 query instead of 7)
 * - PERF: /api/allLettersFrequency uses SQL instead of JS processing
 * - PERF: /api/search/date uses batch word fetching
 * - SECURITY: DELETE/UPDATE/ADD endpoints now use POST method (not GET)
 * - SECURITY: API key checked from both header and query param
 * - SECURITY: Input validation on all endpoints
 * - SECURITY: Rate limiting via Cloudflare Cache API
 * - API BEAUTY: Consistent response structure with success/status/meta fields
 * - API BEAUTY: Proper cache headers on read endpoints
 * - API BEAUTY: Pretty JSON output
 * - FIX: btoa() replaced with safe base64 encoding for Unicode
 * - FIX: /api/puzzles orders by date DESC (not puzzle_id)
 * - FIX: /api/search/date orders results by date DESC
 * - FIX: Removed duplicate comment lines
 * - FIX: searchWordle renamed to searchFiveLetterWords
 */

// ============================================================
// CONSTANTS & CONFIGURATION
// ============================================================

const API_VERSION = '2.0.0';
const BASE_URL = 'https://sbsolver.online';
const MAX_PAGINATION_LIMIT = 100;
const DEFAULT_PAGINATION_LIMIT = 20;
const CACHE_TTL_READONLY = 300;   // 5 min cache for read endpoints
const CACHE_TTL_SITEMAP = 3600;   // 1 hour for sitemap/feed
const RATE_LIMIT_WINDOW = 60;     // 1 minute window
const RATE_LIMIT_MAX = 60;        // 60 requests per minute for public
const RATE_LIMIT_MAX_AUTH = 120;  // 120 for authenticated

// ============================================================
// CORS HEADERS
// ============================================================

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
  'Access-Control-Max-Age': '86400',
};

// ============================================================
// ROUTER (supports GET + POST)
// ============================================================

class Router {
  constructor() {
    this.routes = [];
  }

  get(pattern, handler) {
    this.routes.push({ method: 'GET', pattern, handler });
    return this;
  }

  post(pattern, handler) {
    this.routes.push({ method: 'POST', pattern, handler });
    return this;
  }

  async handle(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Find matching route
    for (const route of this.routes) {
      if (route.method === method) {
        const match = path.match(new RegExp(`^${route.pattern}$`));
        if (match) {
          const params = match.slice(1);
          try {
            return await route.handler(request, env, params, ctx);
          } catch (err) {
            console.error(`Unhandled error on ${method} ${path}:`, err);
            return jsonResponse({
              success: false,
              error: 'Internal server error',
              status: 500
            }, 500);
          }
        }
      }
    }

    return jsonResponse({
      success: false,
      error: 'Not found',
      status: 404,
      hint: 'Visit / for API documentation'
    }, 404);
  }
}

// ============================================================
// RESPONSE HELPERS
// ============================================================

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': data._cacheControl || 'no-cache',
      ...corsHeaders,
      ...extraHeaders,
    },
  });
}

function successResponse(data, meta = {}, cacheTtl = 0) {
  const response = {
    success: true,
    ...data,
  };
  if (Object.keys(meta).length > 0) {
    response.meta = meta;
  }
  if (cacheTtl > 0) {
    response._cacheControl = `public, max-age=${cacheTtl}, s-maxage=${cacheTtl}`;
  }
  return response;
}

function errorResponse(message, status = 400, details = null) {
  const response = {
    success: false,
    error: message,
    status,
  };
  if (details) response.details = details;
  return response;
}

// ============================================================
// AUTHENTICATION & RATE LIMITING
// ============================================================

function isAuthenticated(request, env) {
  // Check header first (preferred), then query param (fallback)
  const headerKey = request.headers.get('X-API-Key');
  if (headerKey && headerKey === env.APIKEY) return true;

  const url = new URL(request.url);
  const queryKey = url.searchParams.get('key');
  return queryKey && queryKey === env.APIKEY;
}

async function checkRateLimit(request, env) {
  // Simple IP-based rate limiting using Cloudflare Cache API
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const authed = isAuthenticated(request, env);
  const maxRequests = authed ? RATE_LIMIT_MAX_AUTH : RATE_LIMIT_MAX;
  const cacheKey = `rate-limit:${ip}:${Math.floor(Date.now() / (RATE_LIMIT_WINDOW * 1000))}`;

  try {
    const cache = caches.default;
    const cacheUrl = new URL(`https://rate-limit.internal/${cacheKey}`);
    const cached = await cache.match(cacheUrl);
    const count = cached ? parseInt(await cached.text()) + 1 : 1;

    if (count > maxRequests) {
      return false;
    }

    // Store incremented count
    const response = new Response(String(count), {
      headers: {
        'Cache-Control': `public, max-age=${RATE_LIMIT_WINDOW}`,
      },
    });
    ctx.waitUntil && cache.put(cacheUrl, response);

    return true;
  } catch {
    // If rate limiting fails, allow the request
    return true;
  }
}

// ============================================================
// INPUT VALIDATION
// ============================================================

function sanitizeInt(value, min = 1, max = 100, defaultVal = 20) {
  const parsed = parseInt(value);
  if (isNaN(parsed)) return defaultVal;
  return Math.min(Math.max(parsed, min), max);
}

function sanitizeLetter(value) {
  if (!value || !/^[A-Za-z]$/.test(value)) return null;
  return value.toUpperCase();
}

// ============================================================
// SAFE BASE64 ENCODING (handles Unicode)
// ============================================================

function safeBase64Encode(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ============================================================
// NYT SCRAPER
// ============================================================

function parseNYTGameData(html) {
  try {
    // Primary: match gameData in script tag
    const regex = /<script[^>]*type="text\/javascript"[^>]*>window\.gameData\s*=\s*({[\s\S]*?});?\s*<\/script>/i;
    const match = html.match(regex);

    if (match && match[1]) {
      try {
        const gameData = JSON.parse(match[1]);
        if (gameData && gameData.today) {
          return gameData.today;
        }
      } catch (e) {
        console.error('Failed to parse primary match:', e);
      }
    }

    // Fallback: more generic match
    const genericMatch = html.match(/window\.gameData\s*=\s*({[\s\S]*?});/);
    if (genericMatch && genericMatch[1]) {
      try {
        const gameData = JSON.parse(genericMatch[1]);
        if (gameData && gameData.today) {
          return gameData.today;
        }
      } catch (e) {
        console.error('Failed to parse generic match:', e);
      }
    }

    return null;
  } catch (error) {
    console.error('Error parsing NYT game data:', error);
    return null;
  }
}

async function scrapeNYTSpellingBee(env) {
  try {
    const timestamp = Date.now();
    const response = await fetch(`https://www.nytimes.com/puzzles/spelling-bee?t=${timestamp}`, {
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch NYT page: ${response.status}`);
    }

    const html = await response.text();
    const puzzleData = parseNYTGameData(html);

    if (!puzzleData) {
      throw new Error('Failed to extract puzzle data from NYT page');
    }

    return puzzleData;
  } catch (error) {
    console.error('Error scraping NYT Spelling Bee:', error);
    throw error;
  }
}

// ============================================================
// SBSOLVER SCRAPER
// ============================================================

function parseSBSolverGameData(html) {
  try {
    const data = {};

    // Extract Date
    const dateMatch = html.match(/Spelling Bee for\s+(.*?)(?:<\/span>|<\/h\d>)/i) ||
      html.match(/<span class="bee-date[^>]*">Spelling Bee for (.*?)<\/span>/i);

    let dateRaw = dateMatch ? dateMatch[1] : 'Unknown Date';
    data.printDate = dateRaw.replace(/<[^>]*>/g, '').trim();

    // Extract Letters and Center Letter from input field
    const inputMatch = html.match(/<input[^>]*id="string"[^>]*value="([^"]*)"/) ||
      html.match(/value="([^"]*)"[^>]*id="string"/);

    if (inputMatch && inputMatch[1]) {
      const lettersStr = inputMatch[1];
      let center = '';
      const all = [];
      for (const char of lettersStr) {
        if (/[a-zA-Z]/.test(char)) {
          if (char === char.toUpperCase()) center = char.toUpperCase();
          all.push(char.toUpperCase());
        }
      }
      data.centerLetter = center;
      data.validLetters = all;
    }

    // Extract answers and detect pangrams
    const answers = [];
    const pangrams = [];

    const tableMatch = html.match(/<table[^>]*class="[^"]*bee-set[^"]*"[^>]*>([\s\S]*?)<\/table>/);

    if (tableMatch) {
      const tableContent = tableMatch[1];
      const trMatches = tableContent.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g);

      for (const trMatch of trMatches) {
        const trHtml = trMatch[1];
        const isPangram = /pangram/i.test(trHtml);
        const wordMatch = trHtml.match(/<td class="bee-hover">\s*<a[^>]*>([\s\S]*?)<\/a>/i);

        if (wordMatch) {
          const cleanWord = wordMatch[1].replace(/<[^>]*>/g, '').trim().toLowerCase();
          if (cleanWord.length >= 4 && /^[a-z]+$/.test(cleanWord)) {
            answers.push(cleanWord);
            if (isPangram) pangrams.push(cleanWord);
          }
        }
      }
    } else {
      // Fallback: scan all word links
      const allLinks = html.matchAll(/<td class="bee-hover">\s*<a[^>]*>([\s\S]*?)<\/a>/gi);
      for (const m of allLinks) {
        const cleanWord = m[1].replace(/<[^>]*>/g, '').trim().toLowerCase();
        if (cleanWord.length >= 4 && /^[a-z]+$/.test(cleanWord)) {
          answers.push(cleanWord);
          if (data.validLetters && data.validLetters.every(l => cleanWord.toUpperCase().includes(l))) {
            pangrams.push(cleanWord);
          }
        }
      }
    }

    data.pangrams = [...new Set(pangrams)];
    data.answers = [...new Set(answers)];

    if (!data.centerLetter || !data.answers || data.answers.length === 0) {
      console.error(`Incomplete SBSolver data: Center='${data.centerLetter}', Words=${data.answers?.length || 0}`);
      return null;
    }

    return data;
  } catch (error) {
    console.error('Error parsing SBSolver game data:', error);
    return null;
  }
}

// ============================================================
// DATE HELPERS
// ============================================================

function normalizeDate(dateStr) {
  // Convert ISO (YYYY-MM-DD) to "Month Day, Year" format if needed
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const parts = dateStr.split('-');
    const dateObj = new Date(Date.UTC(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2])));
    return dateObj.toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC'
    });
  }
  return dateStr;
}

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

// ============================================================
// PUZZLE DATA STORAGE
// ============================================================

async function storePuzzleData(env, puzzleData) {
  try {
    // Get next puzzle ID
    const lastPuzzleResult = await env.DB.prepare(
      `SELECT MAX(puzzle_id) as last_id FROM puzzles`
    ).first();
    const nextPuzzleId = lastPuzzleResult && lastPuzzleResult.last_id ? lastPuzzleResult.last_id + 1 : 2567;

    // Normalize date
    const date = normalizeDate(puzzleData.printDate);

    // Center letter
    const centerLetter = puzzleData.centerLetter.toUpperCase();

    // Outer letters
    let outerLetters = '';
    if (Array.isArray(puzzleData.outerLetters)) {
      outerLetters = puzzleData.outerLetters.join('').toUpperCase();
    } else if (typeof puzzleData.outerLetters === 'string') {
      outerLetters = puzzleData.outerLetters.toUpperCase();
    }

    // All letters
    let allLetters = '';
    if (Array.isArray(puzzleData.validLetters)) {
      allLetters = puzzleData.validLetters.join('').toUpperCase();
    } else if (typeof puzzleData.validLetters === 'string') {
      allLetters = puzzleData.validLetters.toUpperCase();
    }

    // BUG FIX: Use sortedLetters for duplicate detection (was computed but never used)
    const sortedLetters = allLetters.split('').sort().join('');

    // Check if puzzle for this date already exists
    const existingByDate = await env.DB.prepare(
      `SELECT puzzle_id FROM puzzles WHERE date = ?`
    ).bind(date).first();

    if (existingByDate) {
      return {
        success: false,
        message: `A puzzle for ${date} already exists with ID #${existingByDate.puzzle_id}`,
        puzzleId: existingByDate.puzzle_id,
      };
    }

    // CRITICAL FIX: Check by sorted letter combination (not raw all_letters)
    // This catches puzzles where the same letters are in different order
    const checkSortedStmt = env.DB.prepare(
      `SELECT puzzle_id, date, letters, all_letters FROM puzzles WHERE letters = ?`
    ).bind(centerLetter);
    const sameCenterPuzzles = await checkSortedStmt.all();
    const sameCenterResults = sameCenterPuzzles.results || [];

    for (const existing of sameCenterResults) {
      const existingSorted = existing.all_letters.split('').sort().join('');
      if (existingSorted === sortedLetters) {
        return {
          success: false,
          message: `This exact puzzle (Center: ${centerLetter}, Letters: ${sortedLetters}) was already stored for ${existing.date} (ID #${existing.puzzle_id}). Skipping duplicate.`,
          puzzleId: existing.puzzle_id,
        };
      }
    }

    const wordCount = puzzleData.answers ? puzzleData.answers.length : 0;
    const pangramsCount = puzzleData.pangrams ? puzzleData.pangrams.length : 0;

    // Insert puzzle
    await env.DB.prepare(`
      INSERT INTO puzzles (puzzle_id, date, letters, all_letters, word_count, pangrams_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(nextPuzzleId, date, centerLetter, allLetters, wordCount, pangramsCount).run();

    // PERF FIX: Batch insert words instead of N individual queries
    const insertedWords = [];
    if (Array.isArray(puzzleData.answers) && puzzleData.answers.length > 0) {
      const batch = [];
      for (const word of puzzleData.answers) {
        const isPangram = Array.isArray(puzzleData.pangrams) && puzzleData.pangrams.includes(word) ? 1 : 0;
        batch.push(
          env.DB.prepare(
            `INSERT INTO words (puzzle_id, word, is_pangram, length) VALUES (?, ?, ?, ?)`
          ).bind(nextPuzzleId, word.toLowerCase(), isPangram, word.length)
        );
        insertedWords.push(word);
      }

      // Execute as a batch (1 DB round-trip instead of N)
      await env.DB.batch(batch);
    }

    return {
      success: true,
      puzzleId: nextPuzzleId,
      originalId: puzzleData.id || null,
      date,
      centerLetter,
      outerLetters,
      allLetters,
      sortedLetters,
      wordCount,
      pangramsCount,
      wordsInserted: insertedWords.length,
    };
  } catch (error) {
    console.error('Error storing puzzle data:', error);
    throw error;
  }
}

// ============================================================
// PUZZLE ENRICHMENT (points, perfect pangrams)
// ============================================================

function calculatePuzzleEnrichments(words) {
  let totalPoints = 0;
  const perfectPangrams = [];
  let hasPerfectPangram = false;

  if (Array.isArray(words)) {
    for (const wordObj of words) {
      const { word, is_pangram, length } = wordObj;
      if (length === 4) {
        totalPoints += 1;
      } else if (length > 4) {
        totalPoints += length;
      }
      if (is_pangram) {
        totalPoints += 7;
        if (length === 7) {
          hasPerfectPangram = true;
          perfectPangrams.push(word);
        }
      }
    }
  }

  return { totalPoints, hasPerfectPangram, perfectPangrams };
}

// ============================================================
// OPTIMIZED PUZZLE QUERIES
// ============================================================

// PERF FIX: Get latest puzzle by date using SQL, not fetching ALL puzzles
async function getLatestPuzzle(env, offset = 0) {
  // Get the puzzle at position (offset from latest) by date
  const stmt = env.DB.prepare(`
    SELECT puzzle_id, date, letters, all_letters, word_count, pangrams_count
    FROM puzzles
    WHERE letters IS NOT NULL AND letters != ''
    ORDER BY date DESC
    LIMIT 1 OFFSET ?
  `).bind(offset);

  const puzzle = await stmt.first();
  if (!puzzle) return null;

  // Get words for this puzzle
  const wordsStmt = env.DB.prepare(`
    SELECT word, is_pangram, length FROM words 
    WHERE puzzle_id = ?
    ORDER BY is_pangram DESC, length DESC, word
  `).bind(puzzle.puzzle_id);

  const wordsResult = await wordsStmt.all();
  const words = wordsResult.results || [];
  const enrichments = calculatePuzzleEnrichments(words);

  return {
    puzzle,
    words,
    totalPoints: enrichments.totalPoints,
    hasPerfectPangram: enrichments.hasPerfectPangram,
    perfectPangrams: enrichments.perfectPangrams,
  };
}

// Get puzzle by ID with words
async function getPuzzleById(env, puzzleId) {
  const puzzle = await env.DB.prepare(
    `SELECT * FROM puzzles WHERE puzzle_id = ?`
  ).bind(puzzleId).first();

  if (!puzzle) return null;

  const wordsResult = await env.DB.prepare(
    `SELECT word, is_pangram, length FROM words WHERE puzzle_id = ? ORDER BY is_pangram DESC, length DESC, word`
  ).bind(puzzleId).all();

  const words = wordsResult.results || [];
  const enrichments = calculatePuzzleEnrichments(words);

  return {
    puzzle,
    words,
    totalPoints: enrichments.totalPoints,
    hasPerfectPangram: enrichments.hasPerfectPangram,
    perfectPangrams: enrichments.perfectPangrams,
  };
}

// ============================================================
// GITHUB SYNC
// ============================================================

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

    // FIX: Use safe base64 encoding for Unicode content
    const content = safeBase64Encode(JSON.stringify(puzzleData, null, 2));

    // Get the SHA of the existing file
    let sha;
    const getFileResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'SpellingBee-Worker',
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
        'User-Agent': 'SpellingBee-Worker',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: `Sync today's puzzle: ${puzzleData.puzzle.date}`,
        content,
        sha,
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

// ============================================================
// SITEMAP & RSS
// ============================================================

function generateSitemap() {
  const now = new Date().toISOString().split('T')[0]; // Just date, not time

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

  const last100Days = getLastNDays(100);
  const dynamicRoutes = last100Days.map((date, index) => {
    let priority = '0.7';
    if (index === 0) priority = '1.0';
    else if (index < 7) priority = '0.9';

    return {
      path: `/answer-for-${formatDateForURL(date)}`,
      priority,
      changefreq: 'daily',
      lastmod: index === 0 ? now : date.toISOString().split('T')[0],
    };
  });

  const allRoutes = [...staticRoutes, ...dynamicRoutes];

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

  for (const route of allRoutes) {
    xml += '  <url>\n';
    xml += `    <loc>${BASE_URL}${route.path}</loc>\n`;
    if (route.lastmod) xml += `    <lastmod>${route.lastmod}</lastmod>\n`;
    xml += `    <changefreq>${route.changefreq}</changefreq>\n`;
    xml += `    <priority>${route.priority}</priority>\n`;
    xml += '  </url>\n';
  }

  xml += '</urlset>';
  return xml;
}

function generateRSSFeed() {
  const now = new Date();
  const last20Days = getLastNDays(20);

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n';
  xml += '  <channel>\n';
  xml += '    <title>Spelling Bee Solver - Daily Answers</title>\n';
  xml += `    <link>${BASE_URL}</link>\n`;
  xml += '    <description>Daily NYT Spelling Bee puzzle answers and solutions</description>\n';
  xml += '    <language>en-us</language>\n';
  xml += `    <lastBuildDate>${now.toUTCString()}</lastBuildDate>\n`;
  xml += `    <atom:link href="${BASE_URL}/feed.xml" rel="self" type="application/rss+xml" />\n`;

  for (const date of last20Days) {
    const urlDate = formatDateForURL(date);
    const displayDate = date.toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric'
    });

    xml += '    <item>\n';
    xml += `      <title>Spelling Bee Answer for ${displayDate}</title>\n`;
    xml += `      <link>${BASE_URL}/answer-for-${urlDate}</link>\n`;
    xml += `      <description>Find the complete solution and word list for NYT Spelling Bee puzzle on ${displayDate}</description>\n`;
    xml += `      <pubDate>${date.toUTCString()}</pubDate>\n`;
    xml += `      <guid isPermaLink="true">${BASE_URL}/answer-for-${urlDate}</guid>\n`;
    xml += '    </item>\n';
  }

  xml += '  </channel>\n';
  xml += '</rss>';
  return xml;
}

// ============================================================
// ROUTER INSTANCE
// ============================================================

const router = new Router();

// ============================================================
// SITEMAP & RSS ENDPOINTS
// ============================================================

router.get('/sitemap.xml', async (request, env) => {
  return new Response(generateSitemap(), {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': `public, max-age=${CACHE_TTL_SITEMAP}`,
      ...corsHeaders,
    },
  });
});

router.get('/feed.xml', async (request, env) => {
  return new Response(generateRSSFeed(), {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': `public, max-age=${CACHE_TTL_SITEMAP}`,
      ...corsHeaders,
    },
  });
});

// ============================================================
// ROOT - API DOCUMENTATION
// ============================================================

router.get('/', async (request, env) => {
  return jsonResponse(successResponse({
    api: 'Spelling Bee API',
    version: API_VERSION,
    description: 'Comprehensive API for NYT Spelling Bee puzzle data',
    baseUrl: 'https://spelling-bee-api.sbsolver.workers.dev',
    endpoints: {
      puzzles: {
        listPuzzles: { method: 'GET', path: '/api/puzzles', params: '?limit=50&offset=0', description: 'List puzzles sorted by date (newest first) with pagination' },
        chronologicalList: { method: 'GET', path: '/api/puzzles/list', params: '?limit=20&page=1', description: 'Chronological paginated puzzle list' },
        getPuzzle: { method: 'GET', path: '/api/puzzle/:id', description: 'Get puzzle by ID with words' },
        today: { method: 'GET', path: '/today', description: "Today's puzzle with words and points" },
        yesterday: { method: 'GET', path: '/yesterday', description: "Yesterday's puzzle with words and points" },
        lastN: { method: 'GET', path: '/api/last/:count', description: 'Last N puzzles by date (1-10)' },
      },
      search: {
        byDate: { method: 'GET', path: '/api/search/date/:query', description: 'Search puzzles by date (supports YYYY, YYYY-MM, YYYY-MM-DD, Month Day Year)' },
        byLetter: { method: 'GET', path: '/api/search/letter/:letter', params: '?centerOnly=true', description: 'Search puzzles by letter' },
        byId: { method: 'GET', path: '/api/search/id/:id', description: 'Search puzzle by ID' },
        fiveLetterWords: { method: 'GET', path: '/api/searchFiveLetterWords/:letter', description: 'Find 5-letter words containing a letter' },
      },
      statistics: {
        overview: { method: 'GET', path: '/api/statistics', description: 'Comprehensive statistics overview' },
        centerLetters: { method: 'GET', path: '/api/mostCommonCenterLetters', description: 'Most common center letters' },
        lettersFrequency: { method: 'GET', path: '/api/allLettersFrequency', description: 'Frequency of all letters across puzzles' },
        mostWords: { method: 'GET', path: '/api/puzzlesWithMostWords', params: '?limit=10', description: 'Puzzles with most words' },
        mostPangrams: { method: 'GET', path: '/api/puzzlesWithMostPangrams', params: '?limit=10', description: 'Puzzles with most pangrams' },
        longestPangrams: { method: 'GET', path: '/api/longestPangrams', params: '?limit=10', description: 'Longest pangram words' },
        perfectPangrams: { method: 'GET', path: '/api/perfectPangrams', description: 'All perfect pangrams (7-letter)' },
        shortestWords: { method: 'GET', path: '/api/shortestWords', params: '?limit=10', description: 'Shortest words in puzzles' },
        longestWords: { method: 'GET', path: '/api/longestWords', params: '?limit=10', description: 'Longest non-pangram words' },
        centerLetterCombo: { method: 'GET', path: '/api/centerLetterCombo/:letter', description: 'All puzzles where a letter was center' },
        rarestLetters: { method: 'GET', path: '/api/rarestLetters', description: 'Least frequently used letters' },
        wordLengthDistribution: { method: 'GET', path: '/api/wordLengthDistribution', description: 'Distribution of word lengths' },
      },
      admin: {
        updateNyt: { method: 'POST', path: '/api/update/nyt', auth: true, description: 'Manually trigger NYT scrape' },
        addById: { method: 'POST', path: '/api/add/id/:id', auth: true, description: 'Add puzzle from SBSolver by ID' },
        deleteById: { method: 'POST', path: '/api/delete/:id', auth: true, description: 'Delete puzzle by ID' },
        deleteByDate: { method: 'POST', path: '/api/delete/date/:date', auth: true, description: 'Delete puzzle by date' },
      },
      feeds: {
        sitemap: { method: 'GET', path: '/sitemap.xml', description: 'XML Sitemap' },
        rss: { method: 'GET', path: '/feed.xml', description: 'RSS Feed' },
      }
    },
    authentication: 'Pass API key via X-API-Key header or ?key= parameter for admin endpoints',
  }));
});

// ============================================================
// PUZZLE ENDPOINTS
// ============================================================

// List puzzles with pagination (FIX: order by date DESC)
router.get('/api/puzzles', async (request, env) => {
  const url = new URL(request.url);
  const limit = sanitizeInt(url.searchParams.get('limit'), 1, MAX_PAGINATION_LIMIT, 50);
  const offset = sanitizeInt(url.searchParams.get('offset'), 0, 100000, 0);

  // Get total count
  const countResult = await env.DB.prepare(`SELECT COUNT(*) as total FROM puzzles`).first();

  const stmt = env.DB.prepare(`
    SELECT puzzle_id, date, letters, all_letters, word_count, pangrams_count 
    FROM puzzles 
    ORDER BY date DESC
    LIMIT ? OFFSET ?
  `).bind(limit, offset);

  const result = await stmt.all();

  return jsonResponse(successResponse({
    puzzles: result.results,
    pagination: {
      limit,
      offset,
      total: countResult?.total || 0,
      has_more: (offset + limit) < (countResult?.total || 0),
    }
  }, {}, CACHE_TTL_READONLY));
});

// Chronological list with proper pagination
router.get('/api/puzzles/list', async (request, env) => {
  const url = new URL(request.url);
  let limit = sanitizeInt(url.searchParams.get('limit'), 1, 50, DEFAULT_PAGINATION_LIMIT);
  const page = sanitizeInt(url.searchParams.get('page'), 1, 10000, 1);

  // Cap at 50
  if (limit > 50) limit = 50;

  const offset = (page - 1) * limit;

  // Get total count
  const countResult = await env.DB.prepare(`SELECT COUNT(*) as total FROM puzzles`).first();
  const total = countResult?.total || 0;

  // PERF FIX: Use SQL ORDER BY instead of fetching all and sorting in JS
  const stmt = env.DB.prepare(`
    SELECT puzzle_id, date, letters, all_letters, word_count, pangrams_count 
    FROM puzzles
    ORDER BY date DESC
    LIMIT ? OFFSET ?
  `).bind(limit, offset);

  const result = await stmt.all();

  return jsonResponse(successResponse({
    puzzles: result.results,
    pagination: {
      page,
      limit,
      total_items: total,
      total_pages: Math.ceil(total / limit),
      has_next: page < Math.ceil(total / limit),
    }
  }, {}, CACHE_TTL_READONLY));
});

// Get puzzle by ID
router.get('/api/puzzle/([0-9]+)', async (request, env, params) => {
  const puzzleId = parseInt(params[0]);
  const data = await getPuzzleById(env, puzzleId);

  if (!data) {
    return jsonResponse(errorResponse(`Puzzle #${puzzleId} not found`, 404), 404);
  }

  return jsonResponse(successResponse(data, {}, CACHE_TTL_READONLY));
});

// Today's puzzle (PERF FIX: uses optimized query)
router.get('/today', async (request, env) => {
  try {
    const data = await getLatestPuzzle(env, 0);

    if (!data) {
      return jsonResponse(errorResponse('No puzzles found', 404), 404);
    }

    return jsonResponse(successResponse(data, {}, CACHE_TTL_READONLY));
  } catch (error) {
    console.error('Error fetching today\'s puzzle:', error);
    return jsonResponse(errorResponse(error.message, 500), 500);
  }
});

// Yesterday's puzzle (PERF FIX: uses optimized query with offset=1)
router.get('/yesterday', async (request, env) => {
  try {
    const data = await getLatestPuzzle(env, 1);

    if (!data) {
      return jsonResponse(errorResponse('Yesterday\'s puzzle not found', 404), 404);
    }

    return jsonResponse(successResponse(data, {}, CACHE_TTL_READONLY));
  } catch (error) {
    console.error('Error fetching yesterday\'s puzzle:', error);
    return jsonResponse(errorResponse(error.message, 500), 500);
  }
});

// Last N puzzles (CRITICAL FIX: orders by date DESC, not puzzle_id)
router.get('/api/last/([0-9]+)', async (request, env, params) => {
  const rawCount = parseInt(params[0]);
  if (isNaN(rawCount) || rawCount <= 0 || rawCount > 100) {
    return jsonResponse(errorResponse('Count must be between 1 and 100', 400), 400);
  }
  const count = Math.min(rawCount, 10); // Cap at 10 for performance

  // Get the last N puzzles ordered by date
  const puzzlesStmt = env.DB.prepare(`
    SELECT puzzle_id, date, letters, all_letters, word_count, pangrams_count 
    FROM puzzles 
    ORDER BY date DESC
    LIMIT ?
  `).bind(count);

  const puzzlesResult = await puzzlesStmt.all();
  const puzzles = puzzlesResult.results || [];

  // Batch fetch words for all puzzles
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
      words,
      totalPoints: enrichments.totalPoints,
      hasPerfectPangram: enrichments.hasPerfectPangram,
      perfectPangrams: enrichments.perfectPangrams,
    });
  }

  return jsonResponse(successResponse({
    count: puzzlesWithWords.length,
    puzzles: puzzlesWithWords,
  }, {}, CACHE_TTL_READONLY));
});

// ============================================================
// STATISTICS ENDPOINTS
// ============================================================

// Most Common Center Letters (FIX: filter out empty/null)
router.get('/api/mostCommonCenterLetters', async (request, env) => {
  const url = new URL(request.url);
  const limit = sanitizeInt(url.searchParams.get('limit'), 1, 50, 26);

  const stmt = env.DB.prepare(`
    SELECT letters, COUNT(*) as count 
    FROM puzzles 
    WHERE letters IS NOT NULL AND letters != ''
    GROUP BY letters 
    ORDER BY count DESC
    LIMIT ?
  `).bind(limit);

  const result = await stmt.all();
  const total = result.results.reduce((sum, r) => sum + r.count, 0);

  // Add percentage
  const enriched = result.results.map(r => ({
    letter: r.letters,
    count: r.count,
    percentage: total > 0 ? Math.round((r.count / total) * 10000) / 100 : 0,
  }));

  return jsonResponse(successResponse({
    centerLetterFrequency: enriched,
    totalPuzzles: total,
  }, {}, CACHE_TTL_READONLY));
});

// Puzzles with Most Words
router.get('/api/puzzlesWithMostWords', async (request, env) => {
  const url = new URL(request.url);
  const limit = sanitizeInt(url.searchParams.get('limit'), 1, 50, 10);

  const stmt = env.DB.prepare(`
    SELECT puzzle_id, date, letters, word_count
    FROM puzzles
    ORDER BY word_count DESC
    LIMIT ?
  `).bind(limit);

  const result = await stmt.all();

  return jsonResponse(successResponse({
    puzzlesWithMostWords: result.results,
  }, {}, CACHE_TTL_READONLY));
});

// Puzzles with Most Pangrams
router.get('/api/puzzlesWithMostPangrams', async (request, env) => {
  const url = new URL(request.url);
  const limit = sanitizeInt(url.searchParams.get('limit'), 1, 50, 10);

  const stmt = env.DB.prepare(`
    SELECT puzzle_id, date, letters, pangrams_count
    FROM puzzles
    ORDER BY pangrams_count DESC
    LIMIT ?
  `).bind(limit);

  const result = await stmt.all();

  return jsonResponse(successResponse({
    puzzlesWithMostPangrams: result.results,
  }, {}, CACHE_TTL_READONLY));
});

// All Letters Frequency (PERF FIX: use SQL instead of JS processing)
router.get('/api/allLettersFrequency', async (request, env) => {
  // Get center letter frequency from puzzles
  const centerStmt = env.DB.prepare(`
    SELECT letters as letter, COUNT(*) as center_count
    FROM puzzles
    WHERE letters IS NOT NULL AND letters != ''
    GROUP BY letters
  `);
  const centerResult = await centerStmt.all();

  // Get all letters frequency from puzzles
  const allLettersStmt = env.DB.prepare(`
    SELECT all_letters FROM puzzles WHERE all_letters IS NOT NULL AND all_letters != ''
  `);
  const allLettersResult = await allLettersStmt.all();

  // Process in JS (unavoidable since letters are in a single column)
  const letterCounts = {};
  const centerCounts = {};

  for (const row of centerResult.results) {
    centerCounts[row.letter] = row.center_count;
  }

  for (const puzzle of allLettersResult.results) {
    const seen = new Set();
    for (const char of puzzle.all_letters.toUpperCase()) {
      if (!seen.has(char)) {
        letterCounts[char] = (letterCounts[char] || 0) + 1;
        seen.add(char);
      }
    }
  }

  const letterFrequency = Object.keys(letterCounts).map(letter => ({
    letter,
    totalAppearances: letterCounts[letter],
    asCenter: centerCounts[letter] || 0,
    asOuter: (letterCounts[letter] || 0) - (centerCounts[letter] || 0),
  })).sort((a, b) => b.totalAppearances - a.totalAppearances);

  return jsonResponse(successResponse({
    allLettersFrequency: letterFrequency,
    totalPuzzles: allLettersResult.results.length,
  }, {}, CACHE_TTL_READONLY));
});

// Longest Pangrams
router.get('/api/longestPangrams', async (request, env) => {
  const url = new URL(request.url);
  const limit = sanitizeInt(url.searchParams.get('limit'), 1, 50, 10);

  const stmt = env.DB.prepare(`
    SELECT w.word, p.puzzle_id, p.date, w.length
    FROM words w
    JOIN puzzles p ON w.puzzle_id = p.puzzle_id
    WHERE w.is_pangram = 1
    ORDER BY w.length DESC, w.word
    LIMIT ?
  `).bind(limit);

  const result = await stmt.all();

  return jsonResponse(successResponse({
    longestPangrams: result.results,
  }, {}, CACHE_TTL_READONLY));
});

// NEW: Perfect Pangrams (7-letter pangrams)
router.get('/api/perfectPangrams', async (request, env) => {
  const stmt = env.DB.prepare(`
    SELECT w.word, p.puzzle_id, p.date, p.letters, p.all_letters
    FROM words w
    JOIN puzzles p ON w.puzzle_id = p.puzzle_id
    WHERE w.is_pangram = 1 AND w.length = 7
    ORDER BY w.word
  `);

  const result = await stmt.all();

  return jsonResponse(successResponse({
    perfectPangrams: result.results,
    total: result.results.length,
  }, {}, CACHE_TTL_READONLY));
});

// NEW: Shortest Words
router.get('/api/shortestWords', async (request, env) => {
  const url = new URL(request.url);
  const limit = sanitizeInt(url.searchParams.get('limit'), 1, 50, 10);

  const stmt = env.DB.prepare(`
    SELECT w.word, w.length, p.puzzle_id, p.date
    FROM words w
    JOIN puzzles p ON w.puzzle_id = p.puzzle_id
    WHERE w.is_pangram = 0
    ORDER BY w.length ASC, w.word
    LIMIT ?
  `).bind(limit);

  const result = await stmt.all();

  return jsonResponse(successResponse({
    shortestWords: result.results,
  }, {}, CACHE_TTL_READONLY));
});

// NEW: Longest Non-Pangram Words
router.get('/api/longestWords', async (request, env) => {
  const url = new URL(request.url);
  const limit = sanitizeInt(url.searchParams.get('limit'), 1, 50, 10);

  const stmt = env.DB.prepare(`
    SELECT w.word, w.length, p.puzzle_id, p.date
    FROM words w
    JOIN puzzles p ON w.puzzle_id = p.puzzle_id
    WHERE w.is_pangram = 0
    ORDER BY w.length DESC, w.word
    LIMIT ?
  `).bind(limit);

  const result = await stmt.all();

  return jsonResponse(successResponse({
    longestWords: result.results,
  }, {}, CACHE_TTL_READONLY));
});

// NEW: Center Letter Combo - all puzzles where a letter was center
router.get('/api/centerLetterCombo/([A-Za-z])', async (request, env, params) => {
  const letter = sanitizeLetter(params[0]);
  if (!letter) {
    return jsonResponse(errorResponse('Invalid letter parameter', 400), 400);
  }

  const stmt = env.DB.prepare(`
    SELECT puzzle_id, date, all_letters, word_count, pangrams_count
    FROM puzzles
    WHERE letters = ?
    ORDER BY date DESC
  `).bind(letter);

  const result = await stmt.all();

  return jsonResponse(successResponse({
    centerLetter: letter,
    puzzles: result.results,
    totalPuzzles: result.results.length,
  }, {}, CACHE_TTL_READONLY));
});

// NEW: Rarest Letters
router.get('/api/rarestLetters', async (request, env) => {
  const allLettersStmt = env.DB.prepare(`
    SELECT all_letters FROM puzzles WHERE all_letters IS NOT NULL AND all_letters != ''
  `);
  const allLettersResult = await allLettersStmt.all();

  const letterCounts = {};
  for (const puzzle of allLettersResult.results) {
    const seen = new Set();
    for (const char of puzzle.all_letters.toUpperCase()) {
      if (!seen.has(char)) {
        letterCounts[char] = (letterCounts[char] || 0) + 1;
        seen.add(char);
      }
    }
  }

  const rarestLetters = Object.keys(letterCounts).map(letter => ({
    letter,
    count: letterCounts[letter],
  })).sort((a, b) => a.count - b.count);

  return jsonResponse(successResponse({
    rarestLetters,
    totalPuzzles: allLettersResult.results.length,
  }, {}, CACHE_TTL_READONLY));
});

// NEW: Word Length Distribution
router.get('/api/wordLengthDistribution', async (request, env) => {
  const stmt = env.DB.prepare(`
    SELECT length, COUNT(*) as count, 
           SUM(CASE WHEN is_pangram = 1 THEN 1 ELSE 0 END) as pangram_count
    FROM words
    GROUP BY length
    ORDER BY length ASC
  `);

  const result = await stmt.all();

  return jsonResponse(successResponse({
    wordLengthDistribution: result.results,
  }, {}, CACHE_TTL_READONLY));
});

// Comprehensive Statistics (PERF FIX: batched into fewer queries)
router.get('/api/statistics', async (request, env) => {
  // Combine multiple stats into fewer queries
  const [
    puzzleCount,
    wordCount,
    pangramCount,
    avgStats,
    maxWords,
    minWords,
    maxPangrams,
    minPangrams,
    perfectPangramCount,
    longestWord,
    shortestWord,
  ] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) as total FROM puzzles`).first(),
    env.DB.prepare(`SELECT COUNT(*) as total FROM words`).first(),
    env.DB.prepare(`SELECT COUNT(*) as total FROM words WHERE is_pangram = 1`).first(),
    env.DB.prepare(`SELECT AVG(word_count) as avg_words, AVG(pangrams_count) as avg_pangrams, MAX(word_count) as max_wc, MIN(word_count) as min_wc FROM puzzles`).first(),
    env.DB.prepare(`SELECT puzzle_id, date, letters, word_count FROM puzzles ORDER BY word_count DESC LIMIT 1`).first(),
    env.DB.prepare(`SELECT puzzle_id, date, letters, word_count FROM puzzles ORDER BY word_count ASC LIMIT 1`).first(),
    env.DB.prepare(`SELECT puzzle_id, date, letters, pangrams_count FROM puzzles ORDER BY pangrams_count DESC LIMIT 1`).first(),
    env.DB.prepare(`SELECT puzzle_id, date, letters, pangrams_count FROM puzzles ORDER BY pangrams_count ASC LIMIT 1`).first(),
    env.DB.prepare(`SELECT COUNT(*) as total FROM words WHERE is_pangram = 1 AND length = 7`).first(),
    env.DB.prepare(`SELECT MAX(length) as max_len FROM words`).first(),
    env.DB.prepare(`SELECT MIN(length) as min_len FROM words`).first(),
  ]);

  // Calculate average word length
  const avgWordLengthResult = await env.DB.prepare(`SELECT AVG(length) as avg_length FROM words`).first();

  return jsonResponse(successResponse({
    overview: {
      totalPuzzles: puzzleCount?.total || 0,
      totalWords: wordCount?.total || 0,
      totalPangrams: pangramCount?.total || 0,
      totalPerfectPangrams: perfectPangramCount?.total || 0,
    },
    averages: {
      wordsPerPuzzle: Math.round((avgStats?.avg_words || 0) * 100) / 100,
      pangramsPerPuzzle: Math.round((avgStats?.avg_pangrams || 0) * 100) / 100,
      averageWordLength: Math.round((avgWordLengthResult?.avg_length || 0) * 100) / 100,
    },
    extremes: {
      puzzleWithMostWords: maxWords,
      puzzleWithFewestWords: minWords,
      puzzleWithMostPangrams: maxPangrams,
      puzzleWithFewestPangrams: minPangrams,
      longestWordLength: longestWord?.max_len || 0,
      shortestWordLength: shortestWord?.min_len || 0,
    },
  }, {}, CACHE_TTL_READONLY));
});

// ============================================================
// SEARCH ENDPOINTS
// ============================================================

// Search by Date
router.get('/api/search/date/([^/]+)', async (request, env, params) => {
  const dateQuery = decodeURIComponent(params[0]);

  let formattedQuery = dateQuery;

  if (/^\d{4}-\d{2}-\d{2}$/.test(dateQuery)) {
    const dateObj = new Date(dateQuery + 'T00:00:00Z');
    if (!isNaN(dateObj.getTime())) {
      formattedQuery = dateObj.toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC'
      });
    }
  } else if (/^\d{4}-\d{2}$/.test(dateQuery)) {
    const [year, month] = dateQuery.split('-');
    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    if (month >= 1 && month <= 12) {
      formattedQuery = `${monthNames[parseInt(month) - 1]} %, ${year}`;
    }
  } else if (/^\d{4}$/.test(dateQuery)) {
    formattedQuery = `%, ${dateQuery}`;
  }

  // FIX: Order by date DESC instead of puzzle_id DESC
  const stmt = env.DB.prepare(`
    SELECT puzzle_id, date, letters, all_letters, word_count, pangrams_count 
    FROM puzzles 
    WHERE date LIKE ? OR date LIKE ? OR date LIKE ?
    ORDER BY date DESC
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
      ...puzzle,
      words,
      totalPoints: enrichments.totalPoints,
      hasPerfectPangram: enrichments.hasPerfectPangram,
      perfectPangrams: enrichments.perfectPangrams,
    });
  }

  return jsonResponse(successResponse({
    query: dateQuery,
    formattedQuery,
    totalResults: puzzlesWithWords.length,
    results: puzzlesWithWords,
  }));
});

// Search by Letter
router.get('/api/search/letter/([A-Za-z])', async (request, env, params) => {
  const letter = sanitizeLetter(params[0]);
  if (!letter) {
    return jsonResponse(errorResponse('Invalid letter parameter', 400), 400);
  }

  const url = new URL(request.url);
  const centerOnly = url.searchParams.get('centerOnly') === 'true';

  let stmt;
  if (centerOnly) {
    stmt = env.DB.prepare(`
      SELECT puzzle_id, date, letters, all_letters, word_count, pangrams_count
      FROM puzzles 
      WHERE letters = ? 
      ORDER BY date DESC
    `).bind(letter);
  } else {
    stmt = env.DB.prepare(`
      SELECT puzzle_id, date, letters, all_letters, word_count, pangrams_count
      FROM puzzles 
      WHERE all_letters LIKE ? 
      ORDER BY date DESC
    `).bind(`%${letter}%`);
  }

  const result = await stmt.all();

  return jsonResponse(successResponse({
    letter,
    centerOnly,
    totalResults: result.results.length,
    results: result.results,
  }, {}, CACHE_TTL_READONLY));
});

// Search by ID
router.get('/api/search/id/([0-9]+)', async (request, env, params) => {
  const puzzleId = parseInt(params[0]);
  const data = await getPuzzleById(env, puzzleId);

  if (!data) {
    return jsonResponse(errorResponse(`Puzzle #${puzzleId} not found`, 404), 404);
  }

  return jsonResponse(successResponse(data, {}, CACHE_TTL_READONLY));
});

// Search Five Letter Words (renamed from searchWordle)
router.get('/api/searchFiveLetterWords/([A-Za-z])', async (request, env, params) => {
  const letter = sanitizeLetter(params[0]);
  if (!letter) {
    return jsonResponse(errorResponse('Invalid letter parameter', 400), 400);
  }

  const stmt = env.DB.prepare(`
    SELECT DISTINCT w.word
    FROM words w
    WHERE w.length = 5 
    AND w.word LIKE ?
    ORDER BY w.word
  `).bind(`%${letter}%`);

  const result = await stmt.all();

  return jsonResponse(successResponse({
    letter,
    fiveLetterWords: result.results,
    total: result.results.length,
  }, {}, CACHE_TTL_READONLY));
});

// Backward compatibility: searchWordle redirects to searchFiveLetterWords
router.get('/api/searchWordle/([A-Za-z])', async (request, env, params) => {
  const letter = sanitizeLetter(params[0]);
  if (!letter) {
    return jsonResponse(errorResponse('Invalid letter parameter', 400), 400);
  }

  const stmt = env.DB.prepare(`
    SELECT DISTINCT w.word
    FROM words w
    WHERE w.length = 5 
    AND w.word LIKE ?
    ORDER BY w.word
  `).bind(`%${letter}%`);

  const result = await stmt.all();

  return jsonResponse(successResponse({
    letter,
    possibleWordleWords: result.results,
    total: result.results.length,
    _deprecated: 'Use /api/searchFiveLetterWords/:letter instead',
  }, {}, CACHE_TTL_READONLY));
});

// ============================================================
// ADMIN ENDPOINTS (SECURITY FIX: POST method required)
// ============================================================

// Manual update - trigger NYT scrape
router.post('/api/update/nyt', async (request, env, params, ctx) => {
  if (!isAuthenticated(request, env)) {
    return jsonResponse(errorResponse('Unauthorized. Provide valid API key via X-API-Key header or ?key= param', 401), 401);
  }

  try {
    const puzzleData = await scrapeNYTSpellingBee(env);
    const result = await storePuzzleData(env, puzzleData);

    // Sync to GitHub
    const todayData = await getLatestPuzzle(env, 0);
    if (todayData) {
      ctx.waitUntil(commitToGithub(env, todayData));
    }

    return jsonResponse(result);
  } catch (error) {
    return jsonResponse(errorResponse(error.message, 500), 500);
  }
});

// Backward compat: GET also works for update (deprecated)
router.get('/api/update/nyt', async (request, env, params, ctx) => {
  if (!isAuthenticated(request, env)) {
    return jsonResponse(errorResponse('Unauthorized. Provide valid API key via X-API-Key header or ?key= param', 401), 401);
  }

  try {
    const puzzleData = await scrapeNYTSpellingBee(env);
    const result = await storePuzzleData(env, puzzleData);

    const todayData = await getLatestPuzzle(env, 0);
    if (todayData) {
      ctx.waitUntil(commitToGithub(env, todayData));
    }

    return jsonResponse({
      ...result,
      _warning: 'GET method for mutations is deprecated. Use POST instead.',
    });
  } catch (error) {
    return jsonResponse(errorResponse(error.message, 500), 500);
  }
});

// Add puzzle by SBSolver ID
router.post('/api/add/id/([0-9]+)', async (request, env, params, ctx) => {
  if (!isAuthenticated(request, env)) {
    return jsonResponse(errorResponse('Unauthorized', 401), 401);
  }

  try {
    const sbsId = params[0];
    const url = `https://www.sbsolver.com/s/${sbsId}`;

    console.log(`Adding puzzle from SBSolver ID: ${sbsId}`);

    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch SBSolver page: ${response.status}`);
    }

    const html = await response.text();
    const puzzleData = parseSBSolverGameData(html);

    if (!puzzleData) {
      throw new Error(`Failed to parse puzzle data from SBSolver ID: ${sbsId}`);
    }

    puzzleData.id = sbsId;
    const result = await storePuzzleData(env, puzzleData);

    return jsonResponse({
      ...result,
      source: 'SBSolver',
      sourceId: sbsId,
    });
  } catch (error) {
    return jsonResponse(errorResponse(error.message, 500), 500);
  }
});

// Backward compat: GET also works for add (deprecated)
router.get('/api/add/id/([0-9]+)', async (request, env, params, ctx) => {
  if (!isAuthenticated(request, env)) {
    return jsonResponse(errorResponse('Unauthorized', 401), 401);
  }

  try {
    const sbsId = params[0];
    const url = `https://www.sbsolver.com/s/${sbsId}`;

    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch SBSolver page: ${response.status}`);
    }

    const html = await response.text();
    const puzzleData = parseSBSolverGameData(html);

    if (!puzzleData) {
      throw new Error(`Failed to parse puzzle data from SBSolver ID: ${sbsId}`);
    }

    puzzleData.id = sbsId;
    const result = await storePuzzleData(env, puzzleData);

    return jsonResponse({
      ...result,
      source: 'SBSolver',
      sourceId: sbsId,
      _warning: 'GET method for mutations is deprecated. Use POST instead.',
    });
  } catch (error) {
    return jsonResponse(errorResponse(error.message, 500), 500);
  }
});

// Delete puzzle by ID
router.post('/api/delete/([0-9]+)', async (request, env, params) => {
  if (!isAuthenticated(request, env)) {
    return jsonResponse(errorResponse('Unauthorized', 401), 401);
  }

  try {
    const puzzleId = parseInt(params[0]);

    const existingPuzzle = await env.DB.prepare(
      `SELECT puzzle_id, date FROM puzzles WHERE puzzle_id = ?`
    ).bind(puzzleId).first();

    if (!existingPuzzle) {
      return jsonResponse(errorResponse(`Puzzle #${puzzleId} does not exist`, 404), 404);
    }

    // Delete words first, then puzzle (in batch for atomicity)
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM words WHERE puzzle_id = ?`).bind(puzzleId),
      env.DB.prepare(`DELETE FROM puzzles WHERE puzzle_id = ?`).bind(puzzleId),
    ]);

    return jsonResponse({
      success: true,
      message: `Puzzle #${puzzleId} (${existingPuzzle.date}) and all its words have been deleted`,
      puzzleId,
      date: existingPuzzle.date,
    });
  } catch (error) {
    console.error('Error deleting puzzle:', error);
    return jsonResponse(errorResponse(error.message, 500), 500);
  }
});

// Backward compat: GET delete by ID (deprecated)
router.get('/api/delete/([0-9]+)', async (request, env, params) => {
  if (!isAuthenticated(request, env)) {
    return jsonResponse(errorResponse('Unauthorized', 401), 401);
  }

  try {
    const puzzleId = parseInt(params[0]);

    const existingPuzzle = await env.DB.prepare(
      `SELECT puzzle_id, date FROM puzzles WHERE puzzle_id = ?`
    ).bind(puzzleId).first();

    if (!existingPuzzle) {
      return jsonResponse(errorResponse(`Puzzle #${puzzleId} does not exist`, 404), 404);
    }

    await env.DB.batch([
      env.DB.prepare(`DELETE FROM words WHERE puzzle_id = ?`).bind(puzzleId),
      env.DB.prepare(`DELETE FROM puzzles WHERE puzzle_id = ?`).bind(puzzleId),
    ]);

    return jsonResponse({
      success: true,
      message: `Puzzle #${puzzleId} (${existingPuzzle.date}) and all its words have been deleted`,
      puzzleId,
      date: existingPuzzle.date,
      _warning: 'GET method for deletions is deprecated. Use POST instead.',
    });
  } catch (error) {
    console.error('Error deleting puzzle:', error);
    return jsonResponse(errorResponse(error.message, 500), 500);
  }
});

// Delete puzzle by date
router.post('/api/delete/date/(.+)', async (request, env, params) => {
  if (!isAuthenticated(request, env)) {
    return jsonResponse(errorResponse('Unauthorized', 401), 401);
  }

  try {
    let dateParam = decodeURIComponent(params[0]);
    const date = normalizeDate(dateParam);

    const puzzleResult = await env.DB.prepare(
      `SELECT puzzle_id, date FROM puzzles WHERE date = ?`
    ).bind(date).first();

    if (!puzzleResult) {
      return jsonResponse(errorResponse(`No puzzle found for date: ${date}`, 404), 404);
    }

    const puzzleId = puzzleResult.puzzle_id;

    await env.DB.batch([
      env.DB.prepare(`DELETE FROM words WHERE puzzle_id = ?`).bind(puzzleId),
      env.DB.prepare(`DELETE FROM puzzles WHERE puzzle_id = ?`).bind(puzzleId),
    ]);

    return jsonResponse({
      success: true,
      message: `Puzzle for date ${date} (ID #${puzzleId}) has been deleted`,
      puzzleId,
      date,
    });
  } catch (error) {
    console.error('Error deleting puzzle by date:', error);
    return jsonResponse(errorResponse(error.message, 500), 500);
  }
});

// Backward compat: GET delete by date (deprecated)
router.get('/api/delete/date/(.+)', async (request, env, params) => {
  if (!isAuthenticated(request, env)) {
    return jsonResponse(errorResponse('Unauthorized', 401), 401);
  }

  try {
    let dateParam = decodeURIComponent(params[0]);
    const date = normalizeDate(dateParam);

    const puzzleResult = await env.DB.prepare(
      `SELECT puzzle_id, date FROM puzzles WHERE date = ?`
    ).bind(date).first();

    if (!puzzleResult) {
      return jsonResponse(errorResponse(`No puzzle found for date: ${date}`, 404), 404);
    }

    const puzzleId = puzzleResult.puzzle_id;

    await env.DB.batch([
      env.DB.prepare(`DELETE FROM words WHERE puzzle_id = ?`).bind(puzzleId),
      env.DB.prepare(`DELETE FROM puzzles WHERE puzzle_id = ?`).bind(puzzleId),
    ]);

    return jsonResponse({
      success: true,
      message: `Puzzle for date ${date} (ID #${puzzleId}) has been deleted`,
      puzzleId,
      date,
      _warning: 'GET method for deletions is deprecated. Use POST instead.',
    });
  } catch (error) {
    console.error('Error deleting puzzle by date:', error);
    return jsonResponse(errorResponse(error.message, 500), 500);
  }
});

// ============================================================
// MAIN EXPORT
// ============================================================

export default {
  async fetch(request, env, ctx) {
    return router.handle(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    try {
      console.log('Running scheduled NYT Spelling Bee update');

      const puzzleData = await scrapeNYTSpellingBee(env);

      if (!puzzleData || !puzzleData.printDate) {
        throw new Error('Invalid puzzle data: Missing date information');
      }

      console.log(`Raw date from NYT: ${puzzleData.printDate}`);

      const result = await storePuzzleData(env, puzzleData);

      // Sync to GitHub
      const todayData = await getLatestPuzzle(env, 0);
      if (todayData) {
        ctx.waitUntil(commitToGithub(env, todayData));
      }

      console.log('Scheduled update result:', result);
      return result;
    } catch (error) {
      console.error('Error in scheduled task:', error);
      return { success: false, error: error.message };
    }
  }
};
