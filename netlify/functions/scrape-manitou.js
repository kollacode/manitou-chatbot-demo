// netlify/functions/scrape-manitou.js
const https = require("https");
const { URL } = require("url");

exports.handler = async (event, context) => {
  // Enable CORS
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  try {
    const baseUrl = "https://manitouspringsco.gov";
    const scrapedData = await scrapeWebsite(baseUrl);

    return {
      statusCode: 200,
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        success: true,
        pages: scrapedData,
        totalPages: scrapedData.length,
        debugInfo: scrapedData.debugInfo || [],
      }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message }),
    };
  }
};

async function scrapeWebsite(baseUrl) {
  const visitedUrls = new Set();
  const scrapedPages = [];
  const urlsToVisit = [baseUrl];
  const debugInfo = [];

  // Limit to prevent infinite crawling
  const maxPages = 20; // Reduced for debugging
  let pageCount = 0;

  while (urlsToVisit.length > 0 && pageCount < maxPages) {
    const currentUrl = urlsToVisit.shift();

    if (visitedUrls.has(currentUrl)) continue;
    visitedUrls.add(currentUrl);

    try {
      console.log(`Scraping: ${currentUrl}`);
      debugInfo.push(`Attempting to scrape: ${currentUrl}`);

      const pageData = await scrapePage(currentUrl);

      debugInfo.push(
        `Page data for ${currentUrl}: title="${pageData.title}", content length=${pageData.content.length}, links found=${pageData.links.length}`
      );

      // Lower threshold and always include the main page
      if (
        pageData.content &&
        (pageData.content.length > 50 || currentUrl === baseUrl)
      ) {
        scrapedPages.push({
          url: currentUrl,
          title: pageData.title,
          content: pageData.content,
          wordCount: pageData.wordCount,
          lastScraped: new Date().toISOString(),
          debug: `Content length: ${pageData.content.length}`,
        });
        debugInfo.push(`✓ Added page: ${currentUrl}`);
      } else {
        debugInfo.push(
          `✗ Skipped page (too short): ${currentUrl} - ${pageData.content.length} chars`
        );
      }

      // Find more URLs to visit (only within the same domain)
      const newUrls = pageData.links
        .filter((link) => link.startsWith(baseUrl))
        .filter((link) => !visitedUrls.has(link))
        .slice(0, 3); // Reduced for debugging

      urlsToVisit.push(...newUrls);
      debugInfo.push(
        `Found ${newUrls.length} new URLs to visit: ${newUrls
          .slice(0, 2)
          .join(", ")}`
      );

      pageCount++;

      // Small delay to be respectful
      await new Promise((resolve) => setTimeout(resolve, 300));
    } catch (error) {
      console.error(`Error scraping ${currentUrl}:`, error.message);
      debugInfo.push(`ERROR scraping ${currentUrl}: ${error.message}`);
    }
  }

  // Add debug info to the response
  scrapedPages.debugInfo = debugInfo;
  return scrapedPages;
}

function scrapePage(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; ManitouBot/1.0; +https://your-site.netlify.app)",
        },
        timeout: 10000,
      },
      (response) => {
        let data = "";

        response.on("data", (chunk) => {
          data += chunk;
        });

        response.on("end", () => {
          try {
            const parsed = parseHTML(data, url);
            resolve(parsed);
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    request.on("error", reject);
    request.on("timeout", () => {
      request.destroy();
      reject(new Error("Request timeout"));
    });
  });
}

function parseHTML(html, baseUrl) {
  // Extract title
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : "No Title Found";

  // Extract meta description
  const metaMatch = html.match(
    /<meta[^>]*name=['"]description['"][^>]*content=['"]([^'"]*)['"]/i
  );
  const metaDescription = metaMatch ? metaMatch[1] : "";

  // Try multiple content extraction strategies
  let contentArea = html;

  // Strategy 1: Look for main content areas
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const contentMatch = html.match(
    /<div[^>]*(?:class|id)=['"][^'"]*(?:content|main|body)[^'"]*['"][^>]*>([\s\S]*?)<\/div>/i
  );

  if (mainMatch) {
    contentArea = mainMatch[1];
  } else if (articleMatch) {
    contentArea = articleMatch[1];
  } else if (contentMatch) {
    contentArea = contentMatch[1];
  } else {
    // Strategy 2: Remove unwanted sections but keep everything else
    contentArea = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "");
  }

  // Extract text content
  const textContent = contentArea
    .replace(/<[^>]*>/g, " ") // Remove HTML tags
    .replace(/&nbsp;/g, " ") // Replace non-breaking spaces
    .replace(/&amp;/g, "&") // Replace HTML entities
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ") // Normalize whitespace
    .replace(/\n\s*\n/g, "\n") // Remove empty lines
    .trim();

  // Extract links for further crawling - be more flexible
  const linkMatches = html.match(/<a[^>]*href=['"]([^'"]*)['"]/gi) || [];
  const links = linkMatches
    .map((link) => {
      const hrefMatch = link.match(/href=['"]([^'"]*)['"]/i);
      if (!hrefMatch) return null;

      let href = hrefMatch[1];

      // Skip non-useful links
      if (
        href.startsWith("#") ||
        href.startsWith("javascript:") ||
        href.startsWith("mailto:") ||
        href.startsWith("tel:")
      ) {
        return null;
      }

      // Convert relative URLs to absolute
      if (href.startsWith("/")) {
        const urlObj = new URL(baseUrl);
        href = urlObj.origin + href;
      } else if (!href.startsWith("http")) {
        try {
          href = new URL(href, baseUrl).href;
        } catch (e) {
          return null;
        }
      }

      return href;
    })
    .filter((link) => link && link.includes("manitouspringsco.gov"))
    .filter((link, index, arr) => arr.indexOf(link) === index); // Remove duplicates

  const finalContent = metaDescription
    ? `${metaDescription}\n\n${textContent}`
    : textContent;

  return {
    title,
    content: finalContent,
    links,
    wordCount: finalContent.split(" ").filter((word) => word.length > 0).length,
    rawLength: html.length,
    contentLength: finalContent.length,
  };
}
