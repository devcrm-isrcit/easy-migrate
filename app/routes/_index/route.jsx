import { redirect } from "react-router";
import styles from "./styles.module.css";

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return null;
};

// Installs and logins start from the Shopify admin, so this page never asks
// for a shop domain.
export default function App() {
  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Easy Migrate</h1>
        <p className={styles.text}>
          Copy metafield definitions, metaobjects and files between your
          Shopify stores. Open Easy Migrate from your Shopify admin to get
          started.
        </p>
        <ul className={styles.list}>
          <li>
            <strong>Definition sync</strong>. Find the metafield and
            metaobject definitions a store is missing and create them in one
            run.
          </li>
          <li>
            <strong>Files migration</strong>. Move images, videos and other
            files from one of your stores to another.
          </li>
          <li>
            <strong>CSV import and export</strong>. Move definitions as a file
            when the two stores cannot be connected.
          </li>
        </ul>
      </div>
    </div>
  );
}
