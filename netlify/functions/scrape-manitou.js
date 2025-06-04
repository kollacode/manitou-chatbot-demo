// netlify/functions/scrape-manitou.js
const https = require("https");

exports.handler = async (event, context) => {
  // Shorter timeout for Netlify
  context.callbackWaitsForEmptyEventLoop = false;

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  try {
    const debugInfo = [];
    const scrapedPages = [];

    // Start with ONLY the sitemap to get the real URLs
    const urlsToScrape = ["https://www.manitouspringsco.gov/sitemap"];

    debugInfo.push(`Starting with sitemap to discover actual URLs...`);

    for (let i = 0; i < urlsToScrape.length; i++) {
      const url = urlsToScrape[i];

      try {
        debugInfo.push(`Scraping page ${i + 1}: ${url}`);

        const pageData = await scrapePage(url);

        if (pageData.content && pageData.content.length > 50) {
          scrapedPages.push({
            url: url,
            title: pageData.title,
            content: pageData.content,
            wordCount: pageData.wordCount,
            lastScraped: new Date().toISOString(),
          });
          debugInfo.push(
            `✓ Added: ${pageData.title} (${pageData.wordCount} words)`
          );
        } else {
          debugInfo.push(
            `✗ Skipped: ${pageData.title} (only ${pageData.content.length} chars)`
          );
        }

        // If this is the sitemap, grab MORE of its links for scraping
        if (
          url.includes("/sitemap") &&
          pageData.links &&
          pageData.links.length > 0
        ) {
          debugInfo.push(
            `Found ${pageData.links.length} total links in sitemap`
          );
          debugInfo.push(
            `First 10 links: ${pageData.links.slice(0, 10).join(", ")}`
          );

          // Add more links from sitemap - prioritize main section pages
          const additionalUrls = pageData.links
            .filter((link) => {
              // Skip authentication and utility pages
              const path = link.toLowerCase();
              return (
                !path.includes("/myaccount") &&
                !path.includes("/login") &&
                !path.includes("/register") &&
                !path.includes("/search") &&
                !path.includes("/sitemap") &&
                !path.includes(".pdf") &&
                !path.includes(".doc") &&
                !path.includes("facebook.com") &&
                !path.includes("youtube.com")
              );
            })
            .slice(0, 15); // Get 15 more pages instead of 4

          urlsToScrape.push(...additionalUrls);
          debugInfo.push(
            `Added ${additionalUrls.length} URLs from sitemap for scraping`
          );
        }

        // Wait between requests
        if (i < urlsToScrape.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 800));
        }
      } catch (error) {
        debugInfo.push(`✗ Error scraping ${url}: ${error.message}`);
      }
    }

    return {
      statusCode: 200,
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        success: true,
        pages: scrapedPages,
        totalPages: scrapedPages.length,
        debugInfo: debugInfo,
        message: "This is a small batch. Run multiple times to get more pages.",
      }),
    };
  } catch (error) {
    return {
      statusCode: 200,
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        success: false,
        error: error.message,
        debugInfo: [`Main error: ${error.message}`],
      }),
    };
  }
};

function scrapePage(url) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timeout after 5 seconds"));
    }, 5000);

    https
      .get(
        url,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          },
        },
        (response) => {
          // Handle redirects
          if (
            response.statusCode >= 300 &&
            response.statusCode < 400 &&
            response.headers.location
          ) {
            clearTimeout(timeout);
            const redirectUrl = response.headers.location.startsWith("http")
              ? response.headers.location
              : new URL(response.headers.location, url).href;

            scrapePage(redirectUrl).then(resolve).catch(reject);
            return;
          }

          if (response.statusCode !== 200) {
            clearTimeout(timeout);
            reject(new Error(`HTTP ${response.statusCode}`));
            return;
          }

          let data = "";
          response.on("data", (chunk) => (data += chunk));

          response.on("end", () => {
            clearTimeout(timeout);
            try {
              const parsed = parseHTML(data);
              resolve(parsed);
            } catch (error) {
              reject(error);
            }
          });

          response.on("error", (error) => {
            clearTimeout(timeout);
            reject(error);
          });
        }
      )
      .on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
  });
}

function parseHTML(html) {
  // Extract title
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
  const title = titleMatch
    ? titleMatch[1].trim().substring(0, 100)
    : "No Title";

  // For sitemap pages, extract ALL links from the sitemap tree structure
  let links = [];
  if (html.includes("Site Map") || html.includes("sitemap")) {
    // Extract all links from the sitemap's tree structure
    const sitemapMatches = html.match(/<a[^>]*href=['"]([^'"]*)['"]/gi) || [];
    links = sitemapMatches
      .map((link) => {
        const hrefMatch = link.match(/href=['"]([^'"]*)['"]/i);
        if (!hrefMatch) return null;

        let href = hrefMatch[1];

        // Skip non-content links
        if (
          href.startsWith("#") ||
          href.startsWith("javascript:") ||
          href.startsWith("mailto:") ||
          href.startsWith("tel:") ||
          href.includes("facebook.com") ||
          href.includes("twitter.com") ||
          href.includes("instagram.com") ||
          href.includes("youtube.com") ||
          href.includes("nextdoor.com") ||
          href.includes(".pdf") ||
          href.includes(".doc")
        ) {
          return null;
        }

        // Convert relative to absolute
        if (href.startsWith("/")) {
          href = "https://www.manitouspringsco.gov" + href;
        }

        return href;
      })
      .filter((link) => link && link.includes("manitouspringsco.gov"))
      .filter((link, index, arr) => arr.indexOf(link) === index); // Remove duplicates

    console.log(`Found ${links.length} links in sitemap`);
  } else {
    // For regular pages, use normal link extraction
    const linkMatches = html.match(/<a[^>]*href=['"]([^'"]*)['"]/gi) || [];
    links = linkMatches
      .map((link) => {
        const hrefMatch = link.match(/href=['"]([^'"]*)['"]/i);
        if (!hrefMatch) return null;

        let href = hrefMatch[1];

        if (
          href.startsWith("#") ||
          href.startsWith("javascript:") ||
          href.startsWith("mailto:")
        ) {
          return null;
        }

        if (href.startsWith("/")) {
          href = "https://www.manitouspringsco.gov" + href;
        }

        return href;
      })
      .filter((link) => link && link.includes("manitouspringsco.gov"))
      .filter((link, index, arr) => arr.indexOf(link) === index);
  }

  // Simple content extraction
  let content = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 3000); // Limit content

  const wordCount = content.split(" ").filter((word) => word.length > 0).length;

  return {
    title,
    content,
    wordCount,
    links,
  };
}
