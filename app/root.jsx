import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import easyMigrateStyles from "./styles/easy-migrate.css?url";

export const links = () => [
  { rel: "preconnect", href: "https://cdn.shopify.com/" },
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "" },
  { rel: "preload", href: easyMigrateStyles, as: "style" },
  {
    rel: "stylesheet",
    href: "https://cdn.shopify.com/static/fonts/inter/v4/styles.css",
  },
  // Courier Prime and Material Symbols are part of the Easy Migrate design.
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Courier+Prime&display=swap",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap",
  },
  { rel: "stylesheet", href: easyMigrateStyles },
];

const criticalStyles = `
  html {
    background: #f8f9fb;
  }

  body {
    margin: 0;
    background: #f8f9fb;
    color: #1B2430;
    font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
`;

export default function App() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        {/* Raw HTML, not a text child: React escapes quotes in a text child
            during SSR only, which makes hydration report a mismatch. */}
        <style dangerouslySetInnerHTML={{ __html: criticalStyles }} />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
