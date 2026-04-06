import express from 'express';
import path from 'path';
import axios from 'axios';
import * as cheerio from 'cheerio';
import cors from 'cors';

const MANIFEST = {
    id: 'org.subtitlecat.v60',
    version: '1.6.0',
    name: 'SubtitleCat (v60) - NL Vertalingen',
    description: 'Ondertitels van SubtitleCat.com (v60)',
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

async function searchSubtitleCat(query: string, type: string, season?: string, episode?: string, host?: string, imdbId?: string, year?: string) {
    try {
        const stealthHeaders = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'nl-NL,nl;q=0.9,en-US;q=0.8,en;q=0.7',
            'Referer': 'https://subtitlecat.com/'
        };

        // Clean title: remove year in brackets like "Title (2024)" -> "Title"
        let cleanTitle = query.replace(/\s\(\d{4}\)$/, '').trim();
        
        // Try multiple search variations - limit to most effective ones to avoid 403
        const searchQueries = [];
        
        if (imdbId) searchQueries.push(imdbId);
        
        if (type === 'series' && season && episode) {
            const s = season.padStart(2, '0');
            const e = episode.padStart(2, '0');
            searchQueries.push(`${cleanTitle} S${s}E${e}`);
        } else {
            searchQueries.push(cleanTitle);
            if (year) searchQueries.push(`${cleanTitle} ${year}`);
        }

        let allResults: any[] = [];
        
        // Perform searches sequentially or with small delay to avoid rate limiting
        for (const q of searchQueries) {
            const searchUrl = `https://subtitlecat.com/index.php?search=${encodeURIComponent(q)}`;
            const response = await axios.get(searchUrl, {
                headers: stealthHeaders,
                timeout: 7000
            }).catch(() => null);

            if (!response || !response.data) continue;

            const $ = cheerio.load(response.data);
            const localResults: any[] = [];

            $('table.table tr').each((i, el) => {
                if (i === 0) return;
                const link = $(el).find('td:nth-child(1) a');
                const title = link.text().trim();
                const href = link.attr('href');
                const rawLang = $(el).find('td:nth-child(2)').text().trim();
                
                // Column 4 or 5 usually contains translated languages
                const translatedLangs = $(el).find('td').text().toLowerCase();
                const isDutchAvailable = translatedLangs.includes('dutch') || translatedLangs.includes('nederlands');

                // Strict filtering for series to prevent wrong episode matches
                if (type === 'series' && season && episode) {
                    const s = season.padStart(2, '0');
                    const e = episode.padStart(2, '0');
                    const sNum = parseInt(season);
                    const eNum = parseInt(episode);
                    const pattern1 = new RegExp(`S${s}E${e}`, 'i');
                    const pattern2 = new RegExp(`${season}x${episode}`, 'i');
                    const pattern3 = new RegExp(`${s}x${e}`, 'i');
                    const pattern4 = new RegExp(`S${sNum}E${eNum}`, 'i');
                    
                    if (!pattern1.test(title) && !pattern2.test(title) && !pattern3.test(title) && !pattern4.test(title)) {
                        return; // Skip this result
                    }
                }

                if (href && href.startsWith('subs/')) {
                    const parts = href.split('/');
                    const subId = parts[1];
                    const filename = parts[2].replace('.html', '');
                    
                    const baseUrl = host ? `https://${host}` : '';
                    const dutchProxyUrl = `${baseUrl}/proxy/${subId}/${filename}/dutch.srt`;
                    const originalProxyUrl = `${baseUrl}/proxy/${subId}/${filename}.srt`;

                    const statusIcon = isDutchAvailable ? '✅' : '⏳';
                    const statusText = isDutchAvailable ? 'Direct beschikbaar' : 'WACHT 20 SEC!';

                    // Always add Dutch translation
                    localResults.push({
                        url: dutchProxyUrl,
                        lang: 'nld',
                        id: `${subId}-${filename}-nld`,
                        label: `${statusIcon} SubtitleCat: ${title} (${statusText})`
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
            
            allResults = [...allResults, ...localResults];
            if (allResults.length >= 10) break; // Stop if we have enough
            await new Promise(resolve => setTimeout(resolve, 500)); // Small delay between variations
        }
        
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
            const imdbId = cleanId.split(':')[0];
            const year = meta.year || meta.releaseInfo;
            const allSubtitles = await searchSubtitleCat(meta.name, type, season, episode, host, imdbId, year);
            
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
            'Accept-Encoding': 'gzip, deflate, br',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'Sec-Ch-Ua': '"Chromium";v="123", "Not:A-Brand";v="8"',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': '"Windows"',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1',
            'Connection': 'keep-alive'
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
                    timeout: 30000,
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
            let cookies: string[] = [];

            // Strategy 1: Stealth Scrape (Get cookies first)
            try {
                console.log(`[DEBUG] Step 2: Initializing stealth session...`);
                const initRes = await axios.get('https://subtitlecat.com/', {
                    headers: commonHeaders,
                    timeout: 5000
                }).catch(() => null);
                
                if (initRes && initRes.headers['set-cookie']) {
                    cookies = initRes.headers['set-cookie'];
                }

                const scrapeUrls = [
                    `https://subtitlecat.com/subs/${id}`,
                    `https://subtitlecat.com/subs/${id}/${filename}.html`
                ];

                for (const pageUrl of scrapeUrls) {
                    console.log(`[DEBUG] Step 2: Scraping page with cookies: ${pageUrl}`);
                    try {
                        const pageRes = await axios.get(pageUrl, {
                            headers: {
                                ...commonHeaders,
                                'Cookie': cookies.join('; '),
                                'Referer': 'https://subtitlecat.com/'
                            },
                            timeout: 8000,
                            maxRedirects: 5
                        });
                        
                        const $ = cheerio.load(pageRes.data);
                        let downloadPath = '';
                        
                        $('table.table tbody tr').each((i, el) => {
                            const currentLang = $(el).find('td:first-child').text().trim().toLowerCase();
                            if (currentLang.includes(langName) || 
                                (langName === 'dutch' && (currentLang.includes('nederlands') || currentLang.includes('dutch')))) {
                                downloadPath = $(el).find('a[href^="/download/"]').attr('href') || 
                                               $(el).find('a[href^="/subs/"]').attr('href') || '';
                                if (downloadPath) {
                                    console.log(`[DEBUG] Step 2: Found link in table for ${currentLang}: ${downloadPath}`);
                                    return false;
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
                            break;
                        }
                    } catch (e: any) {
                        console.log(`[DEBUG] Scrape attempt failed for ${pageUrl}: ${e.message}`);
                    }
                }
            } catch (scrapeErr: any) {
                console.log(`[DEBUG] Scrape logic failed: ${scrapeErr.message}`);
            }

            // Strategy 2: Brute-force patterns (Fallback)
            if (!success) {
                console.log(`[DEBUG] Scrape didn't work, falling back to brute-force...`);
                
                // If we are looking for Dutch and it failed, try to "trigger" the generation
                // by visiting the main page first if we haven't already
                if (langName === 'dutch') {
                    console.log(`[DEBUG] Triggering generation for Dutch by visiting base page...`);
                    await axios.get(`https://subtitlecat.com/subs/${id}`, {
                        headers: commonHeaders,
                        timeout: 5000
                    }).catch(() => null);
                }

                const baseName = filename.replace(/\.srt$/i, '');
                const pathsToTry: string[] = [];
                
                if (lang) {
                    const langSuffix = langName === 'dutch' ? 'nl' : langName.substring(0, 2);
                    const variations = [
                        filename,
                        baseName,
                        filename.replace(/ /g, '-'),
                        filename.replace(/ /g, '_'),
                        filename.replace(/\./g, '-'),
                        filename.replace(/\./g, '_'),
                        filename.replace(/'/g, ''),
                        filename.replace(/'/g, '-'),
                        filename.replace(/'/g, '.'),
                        filename.replace(/'s/g, 's'),
                        filename.replace(/'s/g, '.s'),
                        baseName.replace(/'/g, ''),
                        baseName.replace(/'/g, '-'),
                        baseName.replace(/'/g, '.'),
                        baseName.replace(/'s/g, 's')
                    ];

                    // Add common subtitle suffixes before the lang suffix
                    const baseVariations = [...variations];
                    baseVariations.forEach(v => {
                        variations.push(`${v}.en`);
                        variations.push(`${v}.eng`);
                    });

                    for (const v of Array.from(new Set(variations))) {
                        pathsToTry.push(`${v}/${langName}.srt`);
                        pathsToTry.push(`${v}-${langSuffix}.srt`);
                    }
                    
                    // Try with comma variations
                    if (filename.includes(',')) {
                        const noComma = filename.replace(/,/g, '');
                        pathsToTry.push(`${noComma}/${langName}.srt`);
                        pathsToTry.push(`${noComma}-${langSuffix}.srt`);
                        pathsToTry.push(`${noComma.replace(/ /g, '-')}-${langSuffix}.srt`);
                    }
                } else {
                    pathsToTry.push(filename.endsWith('.srt') ? filename : `${filename}.srt`);
                    pathsToTry.push(baseName + '.srt');
                    pathsToTry.push(baseName.replace(/ /g, '-') + '.srt');
                }

                const strategies = [
                    { plus: true, subs: false }, { plus: false, subs: false },
                    { plus: true, subs: true }, { plus: false, subs: true }
                ];

                // Attempt loop with retry for Dutch
                let attempts = 0;
                const maxAttempts = langName === 'dutch' ? 4 : 1;

                while (attempts < maxAttempts && !success) {
                    if (attempts > 0) {
                        const waitTime = attempts === 1 ? 10000 : 7000;
                        console.log(`[DEBUG] Retry ${attempts} for Dutch... waiting ${waitTime/1000} seconds for generation...`);
                        await new Promise(resolve => setTimeout(resolve, waitTime));
                    }

                    for (const pathAttempt of pathsToTry) {
                        for (const strat of strategies) {
                            try {
                                const cleanPath = decodeURIComponent(pathAttempt);
                                let encodedPath = "";
                                // Manual encoding to prevent double encoding and allow specific characters
                                for (let i = 0; i < cleanPath.length; i++) {
                                    const char = cleanPath[i];
                                    if (char === ' ') {
                                        encodedPath += strat.plus ? '+' : '%20';
                                    } else if (char === '+') {
                                        // SubtitleCat often expects literal plus in some contexts, but %2B in others
                                        // We'll try both via the plus strategy
                                        encodedPath += strat.plus ? '+' : '%2B';
                                    } else if (/[a-zA-Z0-9\-\.\_\/\(\)\[\],]/.test(char)) {
                                        encodedPath += char;
                                    } else {
                                        encodedPath += encodeURIComponent(char);
                                    }
                                }
                                
                                const prefix = strat.subs ? 'subs' : 'download';
                                const url = `https://subtitlecat.com/${prefix}/${id}/${encodedPath}`;
                                
                                response = await fetchFile(url);
                                success = true;
                                break;
                            } catch (e) { /* continue */ }
                        }
                        if (success) break;
                    }
                    attempts++;
                }
            }

            if (!success || !response) {
                console.log(`[DEBUG] All strategies failed for ${id}. Returning dummy SRT error message.`);
                const dummySrt = "1\n00:00:01,000 --> 00:00:15,000\nSubtitleCat: NL Vertaling mislukt.\n\nOorzaak: SubtitleCat blokkeert de aanvraag (403)\nof de vertaling is nog niet klaar (404).\n\nProbeer een andere versie of wacht 1 minuut.";
                res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                res.setHeader('Access-Control-Allow-Origin', '*');
                return res.send(dummySrt);
            }

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
