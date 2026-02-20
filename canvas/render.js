const { createCanvas, loadImage, registerFont } = require('canvas');
const path = require('path');
const fs = require('fs');

const MAP_PATH = path.join(__dirname, 'map.jpg');
const TREASURE_PATH = path.join(__dirname, 'treasure.png');

// Register Book Antiqua fonts
registerFont(path.join(__dirname, 'BKANT.TTF'), { family: 'Book Antiqua' });
registerFont(path.join(__dirname, 'ANTQUAB.TTF'), { family: 'Book Antiqua', weight: 'bold' });
registerFont(path.join(__dirname, 'ANTQUAI.TTF'), { family: 'Book Antiqua', style: 'italic' });
registerFont(path.join(__dirname, 'ANTQUABI.TTF'), { family: 'Book Antiqua', weight: 'bold', style: 'italic' });

const FONT_FAMILY = "'Book Antiqua'";

// Positions from canvas.md
const POS = {
  island: {
    nameTopLeft: { x: 1045, y: 320 },
    nameSize: { w: 170, h: 60 },
    ySpacing: 17, // between name slots
  },
  treasureBoxes: {
    british: [
      { x: 610, y: 545, w: 120, h: 115 },
      { x: 775, y: 545, w: 120, h: 115 },
    ],
    french: [
      { x: 1275, y: 545, w: 120, h: 115 },
      { x: 1425, y: 545, w: 125, h: 115 },
    ],
  },
  ships: {
    jollyRoger: {
      treasureBox: { x: 878, y: 931, w: 122, h: 114 },
      nameTopLeft: { x: 185, y: 940 },
      nameSize: { w: 170, h: 60 },
      ySpacing: 30,
    },
    flyingDutchman: {
      treasureBox: { x: 1050, y: 931, w: 125, h: 114 },
      nameTopLeft: { x: 1810, y: 940 },
      nameSize: { w: 170, h: 60 },
      ySpacing: 30,
    },
  },
  spanish: {
    startX: 730,
    startY: 1660,
    endX: 1972,
    endY: 1972,
  },
};

async function renderGameState(gameData) {
  const mapImg = await loadImage(MAP_PATH);
  const treasureImg = await loadImage(TREASURE_PATH);

  const canvas = createCanvas(mapImg.width, mapImg.height);
  const ctx = canvas.getContext('2d');

  // Draw base map
  ctx.drawImage(mapImg, 0, 0);

  // --- Draw player names ---
  ctx.fillStyle = '#2a1a0a';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Island residents
  const islandPos = POS.island;
  for (let i = 0; i < gameData.island.residents.length; i++) {
    const name = gameData.island.residents[i];
    const slotX = islandPos.nameTopLeft.x;
    const slotY = islandPos.nameTopLeft.y + i * (islandPos.nameSize.h + islandPos.ySpacing);
    drawClippedName(ctx, name, slotX, slotY, islandPos.nameSize.w, islandPos.nameSize.h);
  }

  // Ship crew
  for (const [shipKey, shipData] of Object.entries({ jollyRoger: gameData.jollyRoger, flyingDutchman: gameData.flyingDutchman })) {
    const shipPos = POS.ships[shipKey];
    for (let i = 0; i < shipData.crew.length; i++) {
      const name = shipData.crew[i];
      const slotX = shipPos.nameTopLeft.x;
      const slotY = shipPos.nameTopLeft.y + i * (shipPos.nameSize.h + shipPos.ySpacing);
      drawClippedName(ctx, name, slotX, slotY, shipPos.nameSize.w, shipPos.nameSize.h);
    }
  }

  // --- Draw treasure chests ---

  // Island treasures (british side)
  for (let i = 0; i < gameData.island.english; i++) {
    const box = POS.treasureBoxes.british[i];
    if (box) drawTreasure(ctx, treasureImg, box);
  }
  // Island treasures (french side)
  for (let i = 0; i < gameData.island.french; i++) {
    const box = POS.treasureBoxes.french[i];
    if (box) drawTreasure(ctx, treasureImg, box);
  }

  // Ship treasure counts (just the number — the map already has a treasure icon)
  for (const shipKey of ['jollyRoger', 'flyingDutchman']) {
    const shipData = gameData[shipKey];
    const box = POS.ships[shipKey].treasureBox;
    const total = shipData.english + shipData.french;
    if (total > 0) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `bold 72px ${FONT_FAMILY}`;
      ctx.fillStyle = '#2a1a0a';
      ctx.strokeStyle = '#3a281688';
      ctx.lineWidth = 5;
      const tx = box.x + box.w / 2;
      const ty = box.y + box.h / 2;
      ctx.strokeText(String(total), tx, ty);
      ctx.fillText(String(total), tx, ty);
      ctx.fillStyle = '#2a1a0a';
    }
  }

  // Spanish galleon treasures (4 boxes)
  const sp = POS.spanish;
  const spBoxW = (sp.endX - sp.startX) / 4;
  const spBoxH = sp.endY - sp.startY;
  for (let i = 0; i < gameData.spanish; i++) {
    const box = {
      x: sp.startX + i * spBoxW,
      y: sp.startY,
      w: spBoxW,
      h: spBoxH,
    };
    drawTreasure(ctx, treasureImg, box);
  }

  return canvas;
}

function drawTreasure(ctx, treasureImg, box) {
  const padding = 8;
  const availW = box.w - padding * 2;
  const availH = box.h - padding * 2;
  const scale = Math.min(availW / treasureImg.width, availH / treasureImg.height);
  const drawW = treasureImg.width * scale;
  const drawH = treasureImg.height * scale;
  const drawX = box.x + (box.w - drawW) / 2;
  const drawY = box.y + (box.h - drawH) / 2;
  ctx.drawImage(treasureImg, drawX, drawY, drawW, drawH);
}

function drawClippedName(ctx, name, x, y, w, h) {
  let firstName = name.split(' ')[0];
  if (firstName.length < 3) firstName = name.split(' ')[1]
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  ctx.fillStyle = '#2a1a0a';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const maxW = w - 10;
  const size = 36;
  ctx.font = `bold ${size}px ${FONT_FAMILY}`;

  // Try single line first
  if (ctx.measureText(firstName).width <= maxW) {
    ctx.fillText(firstName, x + w / 2, y + h / 2);
    ctx.restore();
    return;
  }

  // Try wrapping at whitespace into two lines
  // const words = name.split(/\s+/);
  // if (words.length >= 2) {
  //   // Find best split point
  //   let bestSplit = 1;
  //   let bestDiff = Infinity;
  //   for (let i = 1; i < words.length; i++) {
  //     const line1 = words.slice(0, i).join(' ');
  //     const line2 = words.slice(i).join(' ');
  //     const diff = Math.abs(ctx.measureText(line1).width - ctx.measureText(line2).width);
  //     if (diff < bestDiff) { bestDiff = diff; bestSplit = i; }
  //   }
  //   const line1 = words.slice(0, bestSplit).join(' ');
  //   const line2 = words.slice(bestSplit).join(' ');

  //   // Shrink font if either line still overflows
  //   let s = size;
  //   ctx.font = `bold ${s}px ${FONT_FAMILY}`;
  //   while ((ctx.measureText(line1).width > maxW || ctx.measureText(line2).width > maxW) && s > 10) {
  //     s -= 2;
  //     ctx.font = `bold ${s}px ${FONT_FAMILY}`;
  //   }

  //   const lineHeight = s * 1.15;
  //   const topY = y + h / 2 - lineHeight / 2;
  //   const botY = y + h / 2 + lineHeight / 2;
  //   ctx.fillText(line1, x + w / 2, topY);
  //   ctx.fillText(line2, x + w / 2, botY);
  //   ctx.restore();
  //   return;
  // }

  // Single long word — shrink to fit
  let s = size;
  while (ctx.measureText(firstName).width > maxW && s > 10) {
    s -= 2;
    ctx.font = `bold ${s}px ${FONT_FAMILY}`;
  }
  ctx.fillText(firstName, x + w / 2, y + h / 2);
  ctx.restore();
}

// --- Standalone test ---
if (require.main === module) {
  const mockGame = {
    island: {
      residents: ['Arash', 'Sarah', 'Mohammad'],
      english: 1,
      french: 1,
    },
    jollyRoger: {
      crew: ['Ali', 'Zahra', 'Hossein'],
      english: 2,
      french: 1,
    },
    flyingDutchman: {
      crew: ['Maryam', 'Reza', 'Fatemeh Mohammadi', 'Amir'],
      english: 0,
      french: 1,
    },
    spanish: 3,
  };

  renderGameState(mockGame).then((canvas) => {
    const out = path.join(__dirname, 'test_output.png');
    const buf = canvas.toBuffer('image/png');
    fs.writeFileSync(out, buf);
    console.log(`Rendered to ${out} (${buf.length} bytes)`);
  }).catch(console.error);
}

module.exports = { renderGameState };
