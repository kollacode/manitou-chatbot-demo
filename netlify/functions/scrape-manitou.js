// netlify/functions/scrape-manitou.js
const https = require("https");

exports.handler = async (event, context) => {
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

    // Get batch parameter from query string (default to 0)
    const batch = parseInt(event.queryStringParameters?.batch || "0");

    // First, always get the sitemap to extract URLs (ONLY for batch 0 or if we need URLs)
    debugInfo.push(
      `Starting batch ${batch} - getting sitemap to extract URLs...`
    );

    const sitemapData = await scrapePage(
      "https://www.manitouspringsco.gov/sitemap",
      true
    ); // true = extract links
    debugInfo.push(
      `Sitemap loaded with ${sitemapData.links.length} total links found`
    );

    // Add sitemap to results for batch 0 only
    if (batch === 0) {
      scrapedPages.push({
        url: "https://www.manitouspringsco.gov/sitemap",
        title: sitemapData.title,
        content: sitemapData.content,
        wordCount: sitemapData.wordCount,
        lastScraped: new Date().toISOString(),
        batch: 0,
      });
    }

    // Filter and organize URLs by importance
    const allUrls = sitemapData.links.filter((link) => {
      const path = link.toLowerCase();
      return (
        !path.includes("/myaccount") &&
        !path.includes("/login") &&
        !path.includes("/register") &&
        !path.includes("/search") &&
        !path.includes("/sitemap") &&
        !path.includes(".pdf") &&
        !path.includes("facebook.com") &&
        !path.includes("youtube.com")
      );
    });

    // Organize URLs by priority (main sections first)
    const priorityUrls = [];
    const mainSections = [
      "/I-Want-To",
      "/Community",
      "/Government",
      "/Business",
      "/Visitors",
      "/News",
    ];

    // Add main section URLs first
    mainSections.forEach((section) => {
      const sectionUrls = allUrls.filter((url) => url.includes(section));
      priorityUrls.push(...sectionUrls);
    });

    // Add remaining URLs
    const remainingUrls = allUrls.filter((url) => !priorityUrls.includes(url));
    priorityUrls.push(...remainingUrls);

    debugInfo.push(`Organized ${priorityUrls.length} URLs by priority`);

    // Define batch size - can be larger now since we're not following links
    const batchSize = 8; // Increased from 4
    const startIndex = batch * batchSize;
    const endIndex = startIndex + batchSize;
    const urlsForThisBatch = priorityUrls.slice(startIndex, endIndex);

    debugInfo.push(
      `Batch ${batch}: scraping URLs ${startIndex} to ${
        endIndex - 1
      } (depth 0 only)`
    );
    debugInfo.push(
      `URLs for this batch: ${urlsForThisBatch.slice(0, 3).join(", ")}${
        urlsForThisBatch.length > 3 ? "..." : ""
      }`
    );

    // Scrape the URLs for this batch (NO LINK FOLLOWING)
    for (let i = 0; i < urlsForThisBatch.length; i++) {
      const url = urlsForThisBatch[i];

      try {
        debugInfo.push(`Scraping ${i + 1}/${urlsForThisBatch.length}: ${url}`);

        const pageData = await scrapePage(url, false); // false = don't extract links

        if (pageData.content && pageData.content.length > 50) {
          scrapedPages.push({
            url: url,
            title: pageData.title,
            content: pageData.content,
            wordCount: pageData.wordCount,
            lastScraped: new Date().toISOString(),
            batch: batch,
          });
          debugInfo.push(
            `✓ Added: ${pageData.title} (${pageData.wordCount} words)`
          );
        } else {
          debugInfo.push(
            `✗ Skipped: ${pageData.title} (only ${pageData.content.length} chars)`
          );
        }

        // Shorter wait since we're not following links
        if (i < urlsForThisBatch.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      } catch (error) {
        debugInfo.push(`✗ Error scraping ${url}: ${error.message}`);
      }
    }

    // Calculate totals
    const totalBatches = Math.ceil(priorityUrls.length / batchSize);
    const hasMoreBatches = batch + 1 < totalBatches;

    return {
      statusCode: 200,
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        success: true,
        batch: batch,
        totalBatches: totalBatches,
        hasMoreBatches: hasMoreBatches,
        nextBatch: hasMoreBatches ? batch + 1 : null,
        pages: scrapedPages,
        totalPagesThisBatch: scrapedPages.length,
        totalUrlsAvailable: priorityUrls.length,
        debugInfo: debugInfo,
        instructions: hasMoreBatches
          ? `Run again with ?batch=${batch + 1} to get the next batch`
          : "All batches complete!",
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

function scrapePage(url, extractLinks = false) {
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

            scrapePage(redirectUrl, extractLinks).then(resolve).catch(reject);
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
              const parsed = parseHTML(data, extractLinks);
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

function parseHTML(html, extractLinks = false) {
  // Extract title
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
  const title = titleMatch
    ? titleMatch[1].trim().substring(0, 100)
    : "No Title";

  // Extract links ONLY if requested (for sitemap processing)
  let links = [];
  if (extractLinks) {
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
    .substring(0, 3000);

  const wordCount = content.split(" ").filter((word) => word.length > 0).length;

  return {
    title,
    content,
    wordCount,
    links,
  };
}
