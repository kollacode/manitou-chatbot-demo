// netlify/functions/scrape-manitou.js
const https = require("https");
const { URL } = require("url");

exports.handler = async (event, context) => {
  // Set a timeout for the entire function
  context.callbackWaitsForEmptyEventLoop = false;

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
    // Start with a simple single-page scrape to test
    const testUrl = "https://manitouspringsco.gov";
    const debugInfo = [];

    debugInfo.push(`Starting scrape of: ${testUrl}`);

    const pageData = await scrapePage(testUrl);
    debugInfo.push(
      `Successfully scraped page. Title: "${pageData.title}", Content length: ${pageData.content.length}`
    );

    const scrapedPages = [];

    // Only add if we got meaningful content
    if (pageData.content && pageData.content.length > 20) {
      scrapedPages.push({
        url: pageData.finalUrl || testUrl,
        title: pageData.title,
        content: pageData.content,
        wordCount: pageData.wordCount,
        lastScraped: new Date().toISOString(),
      });
      debugInfo.push(`✓ Added page with ${pageData.wordCount} words`);
    } else {
      debugInfo.push(
        `✗ Page content too short: ${pageData.content.length} characters`
      );
    }

    // Try to get a few more pages from the links we found
    if (pageData.links && pageData.links.length > 0) {
      debugInfo.push(`Found ${pageData.links.length} links to explore`);

      // Try up to 3 additional pages
      const additionalUrls = pageData.links.slice(0, 3);

      for (const url of additionalUrls) {
        try {
          debugInfo.push(`Attempting to scrape: ${url}`);
          const additionalPage = await scrapePage(url);

          if (additionalPage.content && additionalPage.content.length > 100) {
            scrapedPages.push({
              url: additionalPage.finalUrl || url,
              title: additionalPage.title,
              content: additionalPage.content,
              wordCount: additionalPage.wordCount,
              lastScraped: new Date().toISOString(),
            });
            debugInfo.push(`✓ Added additional page: ${additionalPage.title}`);
          } else {
            debugInfo.push(`✗ Skipped page (too short): ${url}`);
          }
        } catch (error) {
          debugInfo.push(`✗ Error scraping ${url}: ${error.message}`);
        }

        // Small delay between requests
        await new Promise((resolve) => setTimeout(resolve, 500));
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
      }),
    };
  } catch (error) {
    return {
      statusCode: 200, // Return 200 even on error so we can see the debug info
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        success: false,
        error: error.message,
        stack: error.stack,
        debugInfo: [`Main error: ${error.message}`],
      }),
    };
  }
};

function scrapePage(url) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Request timeout after 8 seconds"));
    }, 8000);

    const followRedirect = (currentUrl, redirectCount = 0) => {
      if (redirectCount > 3) {
        clearTimeout(timeout);
        reject(new Error("Too many redirects"));
        return;
      }

      const parsedUrl = new URL(currentUrl);
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
          Connection: "close",
        },
      };

      const request = https.request(options, (response) => {
        // Handle redirects
        if (
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          let redirectUrl = response.headers.location;
          if (!redirectUrl.startsWith("http")) {
            redirectUrl = new URL(redirectUrl, currentUrl).href;
          }

          console.log(`Redirecting from ${currentUrl} to ${redirectUrl}`);
          followRedirect(redirectUrl, redirectCount + 1);
          return;
        }

        // Handle non-success status codes
        if (response.statusCode !== 200) {
          clearTimeout(timeout);
          reject(
            new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`)
          );
          return;
        }

        let data = "";
        let size = 0;
        const maxSize = 1024 * 1024; // 1MB limit

        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxSize) {
            clearTimeout(timeout);
            reject(new Error("Response too large"));
            return;
          }
          data += chunk;
        });

        response.on("end", () => {
          clearTimeout(timeout);
          try {
            const parsed = parseHTML(data, currentUrl);
            parsed.finalUrl = currentUrl;
            resolve(parsed);
          } catch (error) {
            reject(error);
          }
        });

        response.on("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });

      request.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      request.end();
    };

    followRedirect(url);
  });
}

function parseHTML(html, baseUrl) {
  try {
    // Extract title
    const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
    const title = titleMatch
      ? titleMatch[1].trim().substring(0, 200)
      : "No Title";

    // Remove scripts, styles, and other non-content elements
    let cleanHtml = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "");

    // Extract text content
    const textContent = cleanHtml
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim()
      .substring(0, 5000); // Limit content length

    // Extract links - be more conservative
    const linkMatches = html.match(/<a[^>]*href=['"]([^'"]*)['"]/gi) || [];
    const links = linkMatches
      .map((link) => {
        const hrefMatch = link.match(/href=['"]([^'"]*)['"]/i);
        if (!hrefMatch) return null;

        let href = hrefMatch[1];

        // Skip anchors, javascript, etc.
        if (
          href.startsWith("#") ||
          href.startsWith("javascript:") ||
          href.startsWith("mailto:")
        ) {
          return null;
        }

        // Convert relative to absolute
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
      .filter(
        (link) => link && (link.includes("manitou") || link.includes("springs"))
      )
      .filter((link, index, arr) => arr.indexOf(link) === index)
      .slice(0, 10); // Limit number of links

    const wordCount = textContent
      .split(" ")
      .filter((word) => word.length > 0).length;

    return {
      title,
      content: textContent,
      links,
      wordCount,
    };
  } catch (error) {
    return {
      title: "Error parsing HTML",
      content: `Parse error: ${error.message}`,
      links: [],
      wordCount: 0,
    };
  }
}
