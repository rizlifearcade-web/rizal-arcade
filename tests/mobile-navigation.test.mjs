import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const arcade = await readFile(new URL("../app/RizalArcade.tsx", import.meta.url), "utf8");
const admin = await readFile(new URL("../app/AdminPortal.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("phone navigation keeps every student destination and sign out accessible", () => {
  assert.match(arcade, /aria-label="Mobile navigation"/);
  for (const label of ["Games", "Badges", "Leaderboard", "Classroom", "Sources", "Sign out"]) {
    assert.match(arcade, new RegExp(`>${label}<`), `${label} must remain available on phones`);
  }
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.mobile-navigation\s*\{[^}]*display:\s*block/s);
  assert.match(css, /\.mobile-navigation > nav > \.mobile-signout\s*\{[^}]*background:\s*var\(--burgundy\)/s);
});

test("desktop navigation is replaced by a dedicated phone menu instead of hiding individual actions", () => {
  assert.match(css, /\.site-header > nav\s*\{\s*display:\s*none/);
  assert.doesNotMatch(css, /\.site-header nav > a,[^}]*\.nav-signout\s*\{\s*display:\s*none/);
  assert.match(arcade, /closeMobileNavigation/);
});

test("the admin phone layout cannot widen beyond the viewport", () => {
  assert.match(css, /\.admin-page\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*overflow-x:\s*clip/s);
  assert.match(css, /\.admin-shell\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0/s);
  assert.match(css, /\.admin-shell > aside\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%/s);
  assert.match(css, /\.admin-workspace\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100vw;[^}]*overflow-x:\s*hidden/s);
});

test("admin sections use a compact labeled selector on phones", () => {
  assert.match(admin, /className="admin-mobile-nav"/);
  assert.match(admin, /select value=\{tab\}/);
  assert.match(admin, /adminTabs\.map/);
  assert.match(css, /\.admin-shell > aside nav\s*\{\s*display:\s*none/);
  assert.match(css, /\.admin-mobile-nav\s*\{[^}]*display:\s*grid/s);
});
