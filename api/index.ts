import express from 'express';
import path from 'path';
import axios from 'axios';
import * as cheerio from 'cheerio';
import cors from 'cors';

const MANIFEST = {
    id: 'org.subtitlecat.v49',
    version: '1.4.9',
    name: 'SubtitleCat (v49) - NL Vertalingen',
    description: 'Ondertitels van SubtitleCat.com (v49)',
    logo: 'https://cdn-icons-png.flaticon.com/512/3503/3503844.png',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt']
};

// Language mapping from SubtitleCat names to Stremio codes (ISO 639-2/B)
const LANG_MAP: Record<string, string> = {
    'dutch': 'nld',
    'english': 'eng',
    'french': 'fre',
    'german': 'ger',
    'spanish': 'spa',
    'italian': 'ita',
    'portuguese': 'por',
    'russian': 'rus',
    'turkish': 'tur',
    'polish': 'pol',
    'hebrew': 'heb',
    'arabic': 'ara',
    'czech': 'cze',
    'hungarian': 'hun',
    'romanian': 'rum',
    'greek': 'gre',
    'danish': 'dan',
    'swedish': 'swe',
    'norwegian': 'nor',
    'finnish': 'fin',
    'albanian': 'sqi',
    'shqip': 'sqi'
};

function mapLanguage(lang: string): string | null {
    // Remove emojis and non-alphabetic characters
    const cleanLang = lang.replace(/[^a-zA-Z]/g, '').toLowerCase();
    if (!cleanLang) return null;
    
    // Check if it's already a 3-letter code we support
    const values = Object.values(LANG_MAP);
    if (values.includes(cleanLang)) return cleanLang;
    
    return LANG_MAP[cleanLang] || null;
}

async function searchSubtitleCat(query: string, type: string, season?: string, episode?: string, host?: string) {
    try {
        // Clean title: remove year in brackets like "Title (2024)" -> "Title"
        const cleanTitle = query.replace(/\s\(\d{4}\)$/, '').trim();
        
        // Try multiple search variations
        const searchQueries = [cleanTitle];
        if (type === 'series' && season && episode) {
            const s = season.padStart(2, '0');
            const e = episode.padStart(2, '0');
            searchQueries.unshift(`${cleanTitle} S${s}E${e}`);
            searchQueries.unshift(`${cleanTitle}.${s}x${e}`);
        }

        let allResults: any[] = [];
        
        // Perform searches in parallel for speed
        const searchPromises = searchQueries.map(async (q) => {
            const searchUrl = `https://subtitlecat.com/index.php?search=${encodeURIComponent(q)}`;
            const response = await axios.get(searchUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                },
                timeout: 4000
            }).catch(() => null);

            if (!response || !response.data) return [];

            const $ = cheerio.load(response.data);
            const localResults: any[] = [];

            $('table.table tr').each((i, el) => {
                if (i === 0) return;
                const link = $(el).find('td:nth-child(1) a');
                const title = link.text().trim();
                const href = link.attr('href');
                const rawLang = $(el).find('td:nth-child(2)').text().trim();

                if (href && href.startsWith('subs/')) {
                    const parts = href.split('/');
                    const subId = parts[1];
                    // Keep the filename as it is in the URL (encoded)
                    const filename = parts[2].replace('.html', '');
                    
                    const baseUrl = host ? `https://${host}` : '';
                    const dutchProxyUrl = `${baseUrl}/proxy/${subId}/${filename}/dutch.srt`;
                    const originalProxyUrl = `${baseUrl}/proxy/${subId}/${filename}.srt`;

                    // Always add Dutch translation
                    localResults.push({
                        url: dutchProxyUrl,
                        lang: 'nld',
                        id: `${subId}-${filename}-nld`,
                        label: `SubtitleCat: ${title} (NL)`
                    });

                    const mappedLang = mapLanguage(rawLang);
                    if (mappedLang && mappedLang !== 'nld') {
                        localResults.push({
                            url: originalProxyUrl,
                            lang: mappedLang,
                            id: `${subId}-${filename}-orig`,
                            label: `SubtitleCat: ${title} (${rawLang})`
                        });
                    }
                }
            });
            return localResults;
        });

        const resultsArray = await Promise.all(searchPromises);
        allResults = resultsArray.flat();
        
        // Remove duplicates and limit results
        const uniqueResults = Array.from(new Map(allResults.map(item => [item.url, item])).values()).slice(0, 20);
        console.log(`[DEBUG] Found ${uniqueResults.length} unique subtitle options for "${cleanTitle}"`);
        return uniqueResults;
    } catch (e) {
        console.error('SubtitleCat search error:', e);
        return [];
    }
}

// Helper to get title from IMDb ID using Cinemeta
async function getMetadata(type: string, id: string) {
    try {
        const imdbId = id.split(':')[0];
        const response = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`);
        return response.data.meta;
    } catch (e) {
        console.error('Cinemeta error:', e);
        return null;
    }
}

async function createServer() {
    const app = express();
    const PORT = process.env.PORT || 3000;

    // Use official cors middleware for better compatibility
    app.use(cors({
        origin: '*',
        methods: ['GET', 'POST', 'OPTIONS', 'HEAD'],
        allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization', 'X-Stremio-User', 'X-Stremio-App']
    }));

    app.use(express.json());

    // 2. Logging
    app.use((req, res, next) => {
        console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
        next();
    });

    // 3. Manifest Serving (Highest priority)
    const serveManifest = (req: any, res: any) => {
        console.log(`[DEBUG] Serving manifest to: ${req.headers['user-agent']}`);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
        res.setHeader('Access-Control-Allow-Headers', '*');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        return res.json(MANIFEST);
    };

    // Multiple paths for maximum compatibility - MUST BE BEFORE OTHER ROUTES
    app.get('/manifest.json', serveManifest);
    app.get('/manifest.v2.json', serveManifest);
    app.get('/manifest', serveManifest);
    
    // Support for Stremio's root-level manifest discovery
    app.get('/', (req, res, next) => {
        const ua = (req.headers['user-agent'] || '').toLowerCase();
        const accept = (req.headers['accept'] || '').toLowerCase();
        
        // If it's Stremio, or requesting JSON, or NOT a browser, serve manifest
        const isStremio = ua.includes('stremio') || accept.includes('json') || req.query.stremio === 'true';
        const isBrowser = ua.includes('mozilla') || ua.includes('chrome') || ua.includes('safari');
        
        if (isStremio || !isBrowser) {
            return serveManifest(req, res);
        }
        // Otherwise, it's a browser, so let it fall through to the frontend
        next();
    });

    // Subtitle route - Catch all variations
    app.get('/subtitles/:type/:id/:extra?', async (req, res) => {
        try {
            let { type, id, extra } = req.params;
            
            // Clean parameters
            const cleanId = id.replace('.json', '');
            const cleanExtra = (extra || '').replace('.json', '');
            
            // Parse requested language from extra (e.g. "language=nld" or just "nld")
            let requestedLang = '';
            if (cleanExtra.includes('language=')) {
                requestedLang = cleanExtra.split('language=')[1].split('&')[0];
            } else if (cleanExtra.length === 3) {
                requestedLang = cleanExtra;
            }
            
            console.log(`[DEBUG] Subtitle request: type=${type}, id=${cleanId}, lang=${requestedLang}`);

            const meta = await getMetadata(type, cleanId);
            if (!meta) {
                return res.json({ subtitles: [] });
            }

            let season, episode;
            if (type === 'series') {
                const parts = cleanId.split(':');
                season = parts[1];
                episode = parts[2];
            }

            const host = req.headers.host;
            const allSubtitles = await searchSubtitleCat(meta.name, type, season, episode, host);
            
            // STRICT FILTERING: Only return the language Stremio asked for
            // If no language is requested, default to Dutch for this addon
            const targetLang = requestedLang || 'nld';
            const filteredSubtitles = allSubtitles.filter(s => s.lang === targetLang);
            
            console.log(`[DEBUG] Returning ${filteredSubtitles.length} subtitles for language: ${targetLang}`);
            res.json({ subtitles: filteredSubtitles });
        } catch (err) {
            console.error('Subtitle route error:', err);
            res.json({ subtitles: [] });
        }
    });

    // Proxy route to handle CORS and direct downloads - using wildcard for robustness
    app.get('/proxy/:id/*', async (req, res) => {
        const id = req.params.id;
        const remainingPath = req.params[0]; // Get the rest of the URL
        
        // Parse filename and lang from the remaining path
        // Format: filename/lang.srt or filename.srt
        const parts = remainingPath.split('/');
        const filename = parts[0];
        const lang = parts.length > 1 ? parts[1] : null;
        const langName = lang ? lang.replace('.srt', '').toLowerCase() : 'english';

        const commonHeaders = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Language': 'nl-NL,nl;q=0.9,en-US;q=0.8,en;q=0.7',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'Sec-Ch-Ua': '"Chromium";v="123", "Not:A-Brand";v="8"',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': '"Windows"',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1'
        };

        const fetchFile = async (url: string) => {
            console.log(`[DEBUG] Step 3: Final Download Attempt: ${url}`);
            try {
                const res = await axios.get(url, {
                    responseType: 'arraybuffer',
                    headers: {
                        ...commonHeaders,
                        'Referer': `https://subtitlecat.com/subs/${id}`
                    },
                    timeout: 15000,
                    maxRedirects: 5,
                    validateStatus: (status) => status === 200
                });
                console.log(`[DEBUG] Step 4: Download Success! Size: ${res.data.length} bytes`);
                return res;
            } catch (err: any) {
                console.error(`[DEBUG] Step 4: Download Failed! Status: ${err.response?.status}, Message: ${err.message}`);
                throw err;
            }
        };

        try {
            console.log(`[DEBUG] Step 1: Proxy Request for ID: ${id}, Lang: ${langName}, File: ${filename}`);
            let response;
            let success = false;

            // Strategy 1: Scrape the page to find the EXACT link (Most Reliable)
            try {
                const pageUrl = `https://subtitlecat.com/subs/${id}`;
                console.log(`[DEBUG] Step 2: Scraping page for real link: ${pageUrl}`);
                const pageRes = await axios.get(pageUrl, {
                    headers: commonHeaders,
                    timeout: 10000
                });
                const $ = cheerio.load(pageRes.data);
                
                let downloadPath = '';
                $('table.table tbody tr').each((i, el) => {
                    const currentLang = $(el).find('td:first-child').text().trim().toLowerCase();
                    // Flexible matching for language
                    if (currentLang.includes(langName) || 
                        (langName === 'dutch' && (currentLang.includes('nederlands') || currentLang.includes('dutch')))) {
                        downloadPath = $(el).find('a[href^="/download/"]').attr('href') || 
                                       $(el).find('a[href^="/subs/"]').attr('href') || '';
                        if (downloadPath) {
                            console.log(`[DEBUG] Step 2: Found link in table for ${currentLang}: ${downloadPath}`);
                            return false; // Break loop
                        }
                    }
                });

                if (!downloadPath && (langName === 'english' || !lang)) {
                    downloadPath = $('#download_file').attr('href') || 
                                   $('a.btn-primary[href^="/download/"]').attr('href') || '';
                }

                if (downloadPath) {
                    const fullUrl = downloadPath.startsWith('http') ? downloadPath : `https://subtitlecat.com${downloadPath}`;
                    response = await fetchFile(fullUrl);
                    success = true;
                }
            } catch (scrapeErr: any) {
                console.log(`[DEBUG] Scrape failed: ${scrapeErr.message}`);
            }

            // Strategy 2: Brute-force patterns (Fallback)
            if (!success) {
                console.log(`[DEBUG] Scrape didn't work, falling back to brute-force...`);
                const baseName = filename.replace(/\.srt$/i, '');
                const pathsToTry: string[] = [];
                
                if (lang) {
                    const langSuffix = langName === 'dutch' ? 'nl' : langName.substring(0, 2);
                    pathsToTry.push(`${filename}/${langName}.srt`);
                    pathsToTry.push(`${baseName}/${langName}.srt`);
                    pathsToTry.push(`${baseName}-${langSuffix}.srt`);
                    pathsToTry.push(`${filename}-${langSuffix}.srt`);
                    // Try with comma replaced by space or removed
                    if (filename.includes(',')) {
                        const noComma = filename.replace(/,/g, '');
                        pathsToTry.push(`${noComma}/${langName}.srt`);
                        pathsToTry.push(`${noComma}-${langSuffix}.srt`);
                    }
                } else {
                    pathsToTry.push(filename.endsWith('.srt') ? filename : `${filename}.srt`);
                    pathsToTry.push(baseName + '.srt');
                }

                const strategies = [
                    { plus: true, subs: false }, { plus: false, subs: false },
                    { plus: true, subs: true }, { plus: false, subs: true }
                ];

                for (const pathAttempt of pathsToTry) {
                    for (const strat of strategies) {
                        try {
                            let cleanPath = decodeURIComponent(pathAttempt);
                            let encodedPath = cleanPath;
                            if (strat.plus) encodedPath = encodedPath.replace(/ /g, '+');
                            else encodedPath = encodedPath.replace(/ /g, '%20');
                            
                            encodedPath = encodedPath.replace(/[^a-zA-Z0-9\+\-\.\_\/\(\)\[\]]/g, (c) => encodeURIComponent(c));
                            const prefix = strat.subs ? 'subs' : 'download';
                            const url = `https://subtitlecat.com/${prefix}/${id}/${encodedPath}`;
                            
                            response = await fetchFile(url);
                            success = true;
                            break;
                        } catch (e) { /* continue */ }
                    }
                    if (success) break;
                }
            }

            if (!success || !response) throw new Error('All download strategies failed');

            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', '*');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            
            res.send(Buffer.from(response.data));
        } catch (e: any) {
            console.error(`[ERROR] Proxy failed for ${id}:`, e.message);
            res.status(404).send(`Subtitle not found. Error: ${e.message}`);
        }
    });

    // 4. Frontend Setup
    // Use __dirname for more reliable path resolution on Vercel
    const distPath = path.resolve(process.cwd(), 'dist');
    const indexHtmlPath = path.join(distPath, 'index.html');
    
    // Check environment based on NODE_ENV or APP_URL
    const isProd = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1' || process.env.K_SERVICE !== undefined;
    
    if (isProd) {
        console.log(`Serving static files from ${distPath}`);
        app.use(express.static(distPath));
        
        // Handle SPA routing
        app.get('*', (req, res, next) => {
            const url = req.url;
            if (url.startsWith('/subtitles') || url.startsWith('/proxy') || url.includes('manifest')) {
                return next();
            }
            res.sendFile(path.join(distPath, 'index.html'));
        });
    } else {
        console.log('Using Vite middleware for development');
        // Dynamic import to avoid loading Vite in production/Vercel
        const { createServer: createViteServer } = await import('vite');
        const vite = await createViteServer({
            server: { middlewareMode: true },
            appType: 'spa',
        });
        app.use(vite.middlewares);
    }

    return app;
}

// Export a function that Vercel can call
const appPromise = createServer();

export default async (req: any, res: any) => {
    const app = await appPromise;
    return app(req, res);
};

// Only listen if not on Vercel
if (!process.env.VERCEL) {
    appPromise.then(app => {
        const PORT = Number(process.env.PORT) || 3000;
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`Addon server listening on 0.0.0.0:${PORT}`);
        });
    });
}
