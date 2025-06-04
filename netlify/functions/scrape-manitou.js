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

  // Limit to prevent infinite crawling
  const maxPages = 50;
  let pageCount = 0;

  while (urlsToVisit.length > 0 && pageCount < maxPages) {
    const currentUrl = urlsToVisit.shift();

    if (visitedUrls.has(currentUrl)) continue;
    visitedUrls.add(currentUrl);

    try {
      console.log(`Scraping: ${currentUrl}`);
      const pageData = await scrapePage(currentUrl);

      if (pageData.content && pageData.content.length > 100) {
        scrapedPages.push({
          url: currentUrl,
          title: pageData.title,
          content: pageData.content,
          lastScraped: new Date().toISOString(),
        });
      }

      // Find more URLs to visit (only within the same domain)
      const newUrls = pageData.links
        .filter((link) => link.startsWith(baseUrl))
        .filter((link) => !visitedUrls.has(link))
        .slice(0, 5); // Limit new URLs per page

      urlsToVisit.push(...newUrls);
      pageCount++;

      // Small delay to be respectful
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (error) {
      console.error(`Error scraping ${currentUrl}:`, error.message);
    }
  }

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
  const title = titleMatch ? titleMatch[1].trim() : "";

  // Extract meta description
  const metaMatch = html.match(
    /<meta[^>]*name=['"]description['"][^>]*content=['"]([^'"]*)['"]/i
  );
  const metaDescription = metaMatch ? metaMatch[1] : "";

  // Remove scripts, styles, and comments
  let cleanHtml = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "") // Remove navigation
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "") // Remove header
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, ""); // Remove footer

  // Extract main content (look for main, article, or content divs)
  const mainContentMatch =
    cleanHtml.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
    cleanHtml.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
    cleanHtml.match(
      /<div[^>]*class=['"][^'"]*content[^'"]*['"][^>]*>([\s\S]*?)<\/div>/i
    );

  const contentArea = mainContentMatch ? mainContentMatch[1] : cleanHtml;

  // Extract text content
  const textContent = contentArea
    .replace(/<[^>]*>/g, " ") // Remove HTML tags
    .replace(/\s+/g, " ") // Normalize whitespace
    .replace(/\n\s*\n/g, "\n") // Remove empty lines
    .trim();

  // Extract links for further crawling
  const linkMatches = html.match(/<a[^>]*href=['"]([^'"]*)['"]/gi) || [];
  const links = linkMatches
    .map((link) => {
      const hrefMatch = link.match(/href=['"]([^'"]*)['"]/i);
      if (!hrefMatch) return null;

      let href = hrefMatch[1];

      // Convert relative URLs to absolute
      if (href.startsWith("/")) {
        const urlObj = new URL(baseUrl);
        href = urlObj.origin + href;
      } else if (!href.startsWith("http")) {
        href = new URL(href, baseUrl).href;
      }

      return href;
    })
    .filter((link) => link && link.startsWith("https://manitouspringsco.gov"))
    .filter((link, index, arr) => arr.indexOf(link) === index); // Remove duplicates

  return {
    title,
    content: metaDescription
      ? `${metaDescription}\n\n${textContent}`
      : textContent,
    links,
    wordCount: textContent.split(" ").length,
  };
}
