import type { ArcadeProfile } from "./auth";
import type { BadgeAward } from "./badgeCatalog";
import type { GameId } from "./games/types";

export type DownloadableBadge = {
  game: GameId;
  name: string;
  title: string;
  art: string;
};

export type BadgeCardDetails = {
  profile: ArcadeProfile;
  badge: DownloadableBadge;
  award: BadgeAward;
};

const CARD_WIDTH = 1600;
const CARD_HEIGHT = 1000;
const PHILIPPINES_TIME_ZONE = "Asia/Manila";

function dateParts(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { label: "Date unavailable", key: "unknown-date" };
  const keyParts = new Intl.DateTimeFormat("en", {
    timeZone: PHILIPPINES_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => keyParts.find((item) => item.type === type)?.value ?? "00";
  return {
    label: new Intl.DateTimeFormat("en-PH", {
      timeZone: PHILIPPINES_TIME_ZONE,
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(date),
    key: `${part("year")}${part("month")}${part("day")}`,
  };
}

function safePart(value: string) {
  return value.trim().replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toUpperCase() || "STUDENT";
}

export function badgeCardReference(studentId: string | null, game: GameId, awardedAt: string) {
  return `RA-${safePart(studentId ?? "student")}-${game.toUpperCase()}-${dateParts(awardedAt).key.toUpperCase()}`;
}

export function badgeCardFilename(studentId: string | null, game: GameId) {
  return `rizal-arcade-${safePart(studentId ?? "student").toLowerCase()}-${game}-badge.png`;
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The badge artwork could not be loaded."));
    image.src = src;
  });
}

function roundedRectangle(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.arcTo(x + width, y, x + width, y + height, safeRadius);
  context.arcTo(x + width, y + height, x, y + height, safeRadius);
  context.arcTo(x, y + height, x, y, safeRadius);
  context.arcTo(x, y, x + width, y, safeRadius);
  context.closePath();
}

function fittedFont(context: CanvasRenderingContext2D, text: string, maxWidth: number, startSize: number, minimumSize: number, family: string) {
  let size = startSize;
  do {
    context.font = family.replace("{size}", String(size));
    if (context.measureText(text).width <= maxWidth) return;
    size -= 2;
  } while (size >= minimumSize);
}

function wrappedLines(context: CanvasRenderingContext2D, text: string, maxWidth: number, maximumLines = 2) {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && context.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= maximumLines) return lines;
  const visible = lines.slice(0, maximumLines);
  visible[maximumLines - 1] = `${visible[maximumLines - 1]}…`;
  return visible;
}

function canvasBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("The browser could not create the badge picture."));
    }, "image/png");
  });
}

export async function createBadgeCardPng({ profile, badge, award }: BadgeCardDetails) {
  if (document.fonts?.ready) await document.fonts.ready;
  const medal = await loadImage(`/art/badges/${badge.art}.svg`);
  const canvas = document.createElement("canvas");
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot create badge pictures.");

  const cream = "#fff3ce";
  const night = "#061923";
  const brass = "#ffc83d";
  const electric = "#4ee0d0";
  const burgundy = "#ed3f50";
  const mutedCream = "#d9d6bb";

  const background = context.createLinearGradient(0, 0, CARD_WIDTH, CARD_HEIGHT);
  background.addColorStop(0, "#061923");
  background.addColorStop(1, "#0b3042");
  context.fillStyle = background;
  context.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

  context.save();
  context.globalAlpha = 0.08;
  context.strokeStyle = electric;
  context.lineWidth = 2;
  for (let x = 0; x <= CARD_WIDTH; x += 55) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, CARD_HEIGHT);
    context.stroke();
  }
  for (let y = 0; y <= CARD_HEIGHT; y += 55) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(CARD_WIDTH, y);
    context.stroke();
  }
  context.restore();

  context.strokeStyle = brass;
  context.lineWidth = 8;
  context.strokeRect(34, 34, CARD_WIDTH - 68, CARD_HEIGHT - 68);
  context.fillStyle = burgundy;
  context.fillRect(34, 34, 22, CARD_HEIGHT - 68);

  roundedRectangle(context, 92, 108, 475, 760, 28);
  context.fillStyle = cream;
  context.fill();
  context.strokeStyle = brass;
  context.lineWidth = 5;
  context.stroke();

  context.fillStyle = burgundy;
  context.beginPath();
  context.arc(329, 374, 190, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = brass;
  context.beginPath();
  context.arc(329, 374, 166, 0, Math.PI * 2);
  context.fill();
  context.drawImage(medal, 174, 219, 310, 310);

  context.textAlign = "center";
  context.fillStyle = night;
  context.font = "900 24px 'DM Sans', Arial, sans-serif";
  context.fillText("RIZAL ARCADE", 329, 648);
  context.fillStyle = "#8f2d3d";
  context.font = "800 20px 'DM Sans', Arial, sans-serif";
  context.fillText("OFFICIAL ACHIEVEMENT", 329, 687);
  context.fillStyle = night;
  context.font = "600 27px 'Cormorant Garamond', Georgia, serif";
  context.fillText("History you can play", 329, 739);
  context.fillStyle = "#1f4235";
  context.font = "800 16px 'DM Sans', Arial, sans-serif";
  context.fillText("RECORDED COMPLETION", 329, 812);

  const contentX = 650;
  const contentWidth = 830;
  context.textAlign = "left";
  context.fillStyle = electric;
  context.font = "900 24px 'DM Sans', Arial, sans-serif";
  context.fillText("PERSONALIZED ACHIEVEMENT BADGE", contentX, 145);

  context.fillStyle = cream;
  context.font = "700 78px 'Cormorant Garamond', Georgia, serif";
  const badgeLines = wrappedLines(context, badge.name, contentWidth, 2);
  badgeLines.forEach((line, index) => context.fillText(line, contentX, 238 + index * 76));
  const gameY = 238 + badgeLines.length * 76 + 18;
  context.fillStyle = brass;
  fittedFont(context, badge.title, contentWidth, 30, 22, "850 {size}px 'DM Sans', Arial, sans-serif");
  context.fillText(badge.title, contentX, gameY);

  context.strokeStyle = "rgba(255,243,206,.35)";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(contentX, 455);
  context.lineTo(contentX + contentWidth, 455);
  context.stroke();

  context.fillStyle = mutedCream;
  context.font = "800 20px 'DM Sans', Arial, sans-serif";
  context.fillText("AWARDED TO", contentX, 510);
  context.fillStyle = cream;
  fittedFont(context, profile.display_name, contentWidth, 62, 36, "700 {size}px 'Cormorant Garamond', Georgia, serif");
  context.fillText(profile.display_name, contentX, 578);
  context.fillStyle = mutedCream;
  context.font = "500 22px 'DM Sans', Arial, sans-serif";
  context.fillText(`for completing ${badge.title}`, contentX, 620);

  const awardedDate = dateParts(award.awarded_at);
  const metadata = [
    ["STUDENT ID", profile.student_id ?? "Not assigned"],
    ["SECTION", profile.section?.section_code ?? "Not assigned"],
    ["COMPLETED", awardedDate.label],
  ];
  const metadataWidth = 256;
  metadata.forEach(([label, value], index) => {
    const x = contentX + index * 285;
    roundedRectangle(context, x, 677, metadataWidth, 112, 12);
    context.fillStyle = "rgba(255,243,206,.08)";
    context.fill();
    context.strokeStyle = "rgba(78,224,208,.45)";
    context.lineWidth = 2;
    context.stroke();
    context.fillStyle = electric;
    context.font = "850 15px 'DM Sans', Arial, sans-serif";
    context.fillText(label, x + 18, 711);
    context.fillStyle = cream;
    fittedFont(context, value, metadataWidth - 36, 22, 16, "750 {size}px 'DM Sans', Arial, sans-serif");
    context.fillText(value, x + 18, 756);
  });

  const reference = badgeCardReference(profile.student_id, badge.game, award.awarded_at);
  context.fillStyle = brass;
  context.font = "850 17px ui-monospace, SFMono-Regular, Consolas, monospace";
  context.fillText(`REFERENCE · ${reference}`, contentX, 855);
  context.fillStyle = mutedCream;
  context.font = "500 17px 'DM Sans', Arial, sans-serif";
  context.fillText("Issued from this student’s recorded Rizal Arcade completion.", contentX, 892);
  context.textAlign = "right";
  context.fillStyle = cream;
  context.font = "700 17px 'DM Sans', Arial, sans-serif";
  context.fillText("rizal-arcade.vercel.app", 1480, 945);

  return canvasBlob(canvas);
}

export async function downloadPersonalizedBadge(details: BadgeCardDetails) {
  const blob = await createBadgeCardPng(details);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = badgeCardFilename(details.profile.student_id, details.badge.game);
  anchor.rel = "noopener";
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
