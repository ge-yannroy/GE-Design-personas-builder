// ============================================================================
// GE-DESIGN Personas Builder
// Genere une instance de composant/frame par ligne de CSV :
//  - remplit les calques texte dont le nom correspond a une colonne (exact,
//    insensible a la casse) ;
//  - deplace les curseurs de slider (calques nommes "slider:<colonne>") le
//    long de leur rail parent, selon une valeur 0-100 lue dans la colonne.
// ============================================================================

// ---- Types de messages UI <-> main ----------------------------------------

interface SelectionInfoMsg {
  type: "selection-info";
  valid: boolean;
  reason?: string;
  templateName?: string;
  templateType?: string;
  textLayerNames?: string[];
  sliderColumnNames?: string[];
}

interface GenerateMsg {
  type: "generate";
  rows: Record<string, string>[];
  headers: string[];
  columnsPerRow: number;
  gutterX: number;
  gutterY: number;
}

interface GenerationResultMsg {
  type: "generation-result";
  createdCount: number;
  unmatchedColumns: string[];
  unmatchedLayers: string[];
  unmatchedSliders: string[];
  invalidSliderValues: number;
  errorRows: number;
}

interface ErrorMsg {
  type: "error";
  message: string;
}

type TemplateNode = ComponentNode | InstanceNode | FrameNode | GroupNode | ComponentSetNode;

const SLIDER_PREFIX = "slider:";

// ---- Etat --------------------------------------------------------------

let currentTemplate: TemplateNode | null = null;
let currentTextLayerNames: string[] = [];
let currentSliderColumnNames: string[] = [];

// ---- Utilitaires ---------------------------------------------------------

/** Types de noeuds pouvant servir de gabarit. */
function isSupportedTemplateType(node: SceneNode): node is TemplateNode {
  return (
    node.type === "COMPONENT" ||
    node.type === "INSTANCE" ||
    node.type === "FRAME" ||
    node.type === "GROUP" ||
    node.type === "COMPONENT_SET"
  );
}

/** true si le noeud a un type porteur de x/width utilisable comme rail ou curseur. */
function hasLayoutGeometry(
  node: BaseNode
): node is SceneNode & LayoutMixin {
  return "x" in node && "width" in node;
}

/**
 * Cherche le "rail" visuel associe a un curseur de slider : le frere le plus
 * large (autre que le curseur lui-meme) dans le meme parent, ex. un
 * MD_Divider. On ne peut pas se fier a la largeur du parent direct du
 * curseur : si ce parent est en auto-layout avec un sizing "hug contents",
 * Figma ignore les enfants en position absolue (le curseur) dans ce calcul —
 * la largeur du parent ne reflete alors que celle du rail seul, pas la
 * largeur visuelle complete, ou pire, tombe a une valeur degeneree.
 * Utiliser directement le frere "rail" (et sa position x, pas seulement sa
 * largeur, pour tenir compte d'un eventuel padding interne) est fiable dans
 * les deux cas de figure (parent en auto-layout ou frame classique).
 */
function findTrackSibling(handle: SceneNode): (SceneNode & LayoutMixin) | null {
  const parent = handle.parent;
  if (!parent || !("children" in parent)) {
    return null;
  }
  const siblings = (parent as ChildrenMixin).children;
  let best: (SceneNode & LayoutMixin) | null = null;
  let bestWidth = -1;
  for (let i = 0; i < siblings.length; i++) {
    const sibling = siblings[i];
    if (sibling === handle) {
      continue;
    }
    if (hasLayoutGeometry(sibling) && sibling.width > bestWidth) {
      bestWidth = sibling.width;
      best = sibling;
    }
  }
  return best;
}

/** Parcourt recursivement les enfants d'un noeud pour trouver tous les TEXT. */
function findTextNodes(node: BaseNode): TextNode[] {
  const result: TextNode[] = [];

  function walk(n: BaseNode): void {
    if (n.type === "TEXT") {
      result.push(n as TextNode);
    }
    if ("children" in n) {
      const children = (n as ChildrenMixin).children;
      for (let i = 0; i < children.length; i++) {
        walk(children[i]);
      }
    }
  }

  walk(node);
  return result;
}

/**
 * Parcourt recursivement les enfants d'un noeud pour trouver tous les
 * curseurs de slider : tout noeud (non-TEXT) dont le nom commence par
 * "slider:" (insensible a la casse). Retourne le noeud + le nom de colonne
 * extrait (partie apres le prefixe).
 */
function findSliderHandles(node: BaseNode): { node: SceneNode; columnName: string }[] {
  const result: { node: SceneNode; columnName: string }[] = [];

  function walk(n: BaseNode): void {
    if (n.type !== "TEXT" && "name" in n) {
      const name = (n as SceneNode).name;
      const lower = name.trim().toLowerCase();
      if (lower.indexOf(SLIDER_PREFIX) === 0) {
        const columnName = name.trim().slice(SLIDER_PREFIX.length).trim();
        if (columnName.length > 0) {
          result.push({ node: n as SceneNode, columnName: columnName });
        }
      }
    }
    if ("children" in n) {
      const children = (n as ChildrenMixin).children;
      for (let i = 0; i < children.length; i++) {
        walk(children[i]);
      }
    }
  }

  walk(node);
  return result;
}

/** Charge toutes les polices utilisees par un noeud texte (gere les polices mixtes). */
async function loadFontsForTextNode(node: TextNode): Promise<void> {
  const len = node.characters.length;

  if (node.fontName !== figma.mixed) {
    await figma.loadFontAsync(node.fontName as FontName);
    return;
  }

  if (len === 0) {
    const fallback = node.getRangeFontName(0, 1);
    if (fallback !== figma.mixed) {
      await figma.loadFontAsync(fallback as FontName);
    }
    return;
  }

  const seen = new Set<string>();
  const fonts: FontName[] = [];
  for (let i = 0; i < len; i++) {
    const f = node.getRangeFontName(i, i + 1);
    if (f !== figma.mixed) {
      const font = f as FontName;
      const key = font.family + "::" + font.style;
      if (!seen.has(key)) {
        seen.add(key);
        fonts.push(font);
      }
    }
  }

  for (let i = 0; i < fonts.length; i++) {
    await figma.loadFontAsync(fonts[i]);
  }
}

/** Recherche insensible a la casse d'une colonne correspondant a un nom (calque ou slider). */
function findMatchingColumn(
  name: string,
  columnLookup: Map<string, string>
): string | undefined {
  return columnLookup.get(name.trim().toLowerCase());
}

/** Duplique le gabarit : createInstance() pour un COMPONENT, clone() sinon. */
function duplicateTemplate(template: TemplateNode): FrameNode | GroupNode | ComponentNode | InstanceNode {
  if (template.type === "COMPONENT") {
    return template.createInstance();
  }
  if (template.type === "COMPONENT_SET") {
    const firstVariant = template.children[0] as ComponentNode;
    return firstVariant.createInstance();
  }
  return template.clone() as FrameNode | GroupNode | InstanceNode;
}

/**
 * Positionne un curseur de slider selon une valeur 0-100.
 * Strategie principale : utiliser le frere "rail" (ex. MD_Divider) comme
 * reference de largeur ET de position de depart (gere un eventuel padding).
 * Repli : si aucun frere exploitable n'est trouve, retombe sur l'ancienne
 * methode (largeur du parent direct, origine x=0) pour rester compatible
 * avec des gabarits plus simples ou le parent EST directement le rail.
 */
function positionSliderHandle(handle: SceneNode, value: number): boolean {
  if (!hasLayoutGeometry(handle)) {
    return false;
  }

  const parent = handle.parent;

  // Si le curseur est enfant d'un frame en auto-layout, on le bascule en
  // positionnement absolu pour pouvoir le deplacer librement.
  if (parent && "layoutMode" in parent && (parent as FrameNode).layoutMode !== "NONE") {
    if ("layoutPositioning" in handle) {
      (handle as FrameNode).layoutPositioning = "ABSOLUTE";
    }
  }

  const clamped = Math.max(0, Math.min(100, value));

  const track = findTrackSibling(handle);
  if (track) {
    const usable = track.width - handle.width;
    if (usable > 0) {
      handle.x = track.x + (clamped / 100) * usable;
      return true;
    }
  }

  // Repli : comportement precedent (parent = rail, origine x=0).
  if (parent && hasLayoutGeometry(parent)) {
    const usable = parent.width - handle.width;
    if (usable > 0) {
      handle.x = (clamped / 100) * usable;
      return true;
    }
  }

  return false;
}

// ---- Analyse de la selection ----------------------------------------------

function analyzeSelection(): SelectionInfoMsg {
  const selection = figma.currentPage.selection;

  if (selection.length !== 1) {
    currentTemplate = null;
    currentTextLayerNames = [];
    currentSliderColumnNames = [];
    return {
      type: "selection-info",
      valid: false,
      reason:
        selection.length === 0
          ? "Aucun element selectionne. Selectionnez un composant ou une frame gabarit."
          : "Plusieurs elements selectionnes. Selectionnez un seul gabarit.",
    };
  }

  const node = selection[0];

  if (!isSupportedTemplateType(node)) {
    currentTemplate = null;
    currentTextLayerNames = [];
    currentSliderColumnNames = [];
    return {
      type: "selection-info",
      valid: false,
      reason:
        "Le type d'element selectionne (" +
        node.type +
        ") n'est pas pris en charge. Utilisez un composant, une instance, une frame ou un groupe.",
    };
  }

  const template = node as TemplateNode;
  const rootForScan = template.type === "COMPONENT_SET" ? template.children[0] : template;
  const textNodes = findTextNodes(rootForScan);
  const sliderHandles = findSliderHandles(rootForScan);

  if (textNodes.length === 0 && sliderHandles.length === 0) {
    currentTemplate = null;
    currentTextLayerNames = [];
    currentSliderColumnNames = [];
    return {
      type: "selection-info",
      valid: false,
      reason: "Aucun calque texte ni curseur de slider (\"slider:...\") trouve dans ce gabarit.",
    };
  }

  currentTemplate = template;
  currentTextLayerNames = textNodes.map((t) => t.name);
  currentSliderColumnNames = sliderHandles.map((s) => s.columnName);

  return {
    type: "selection-info",
    valid: true,
    templateName: template.name,
    templateType: template.type,
    textLayerNames: currentTextLayerNames,
    sliderColumnNames: currentSliderColumnNames,
  };
}

function postSelectionInfo(): void {
  figma.ui.postMessage(analyzeSelection());
}

// ---- Generation -------------------------------------------------------

async function generateFromRows(msg: GenerateMsg): Promise<void> {
  if (!currentTemplate) {
    figma.ui.postMessage({
      type: "error",
      message: "Aucun gabarit valide selectionne.",
    } as ErrorMsg);
    return;
  }

  const template = currentTemplate;
  const rows = msg.rows;
  const headers = msg.headers;

  const columnLookup = new Map<string, string>();
  for (let i = 0; i < headers.length; i++) {
    columnLookup.set(headers[i].trim().toLowerCase(), headers[i]);
  }

  // Bilan de correspondance (texte + sliders) sur le gabarit courant.
  const matchedColumns = new Set<string>();
  const matchedLayers = new Set<string>();
  for (let i = 0; i < currentTextLayerNames.length; i++) {
    const layerName = currentTextLayerNames[i];
    const col = findMatchingColumn(layerName, columnLookup);
    if (col) {
      matchedColumns.add(col);
      matchedLayers.add(layerName);
    }
  }
  const matchedSliderCols = new Set<string>();
  for (let i = 0; i < currentSliderColumnNames.length; i++) {
    const sliderCol = currentSliderColumnNames[i];
    const col = findMatchingColumn(sliderCol, columnLookup);
    if (col) {
      matchedColumns.add(col);
      matchedSliderCols.add(sliderCol);
    }
  }
  const unmatchedColumns = headers.filter((h) => !matchedColumns.has(h));
  const uniqueLayerNames = Array.from(new Set(currentTextLayerNames));
  const unmatchedLayers = uniqueLayerNames.filter((l) => !matchedLayers.has(l));
  const uniqueSliderCols = Array.from(new Set(currentSliderColumnNames));
  const unmatchedSliders = uniqueSliderCols.filter((s) => !matchedSliderCols.has(s));

  if (matchedColumns.size === 0) {
    figma.ui.postMessage({
      type: "error",
      message:
        "Aucune colonne du CSV ne correspond a un nom de calque texte ou de slider du gabarit. Verifiez l'orthographe.",
    } as ErrorMsg);
    return;
  }

  const columnsPerRow = Math.max(1, Math.floor(msg.columnsPerRow) || 1);
  const gutterX = Math.max(0, msg.gutterX || 0);
  const gutterY = Math.max(0, msg.gutterY || 0);

  const originX = template.x;
  const originY = template.y + template.height + Math.max(gutterY, 40);
  const stepX = template.width + gutterX;
  const stepY = template.height + gutterY;

  const createdNodes: SceneNode[] = [];
  let errorRows = 0;
  let invalidSliderValues = 0;

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    try {
      const instance = duplicateTemplate(template);

      // -- Calques texte --
      const textNodes = findTextNodes(instance);
      for (let t = 0; t < textNodes.length; t++) {
        const textNode = textNodes[t];
        const col = findMatchingColumn(textNode.name, columnLookup);
        if (!col) {
          continue;
        }
        const value = row[col] !== undefined ? row[col] : "";
        await loadFontsForTextNode(textNode);
        textNode.characters = value;
      }

      // -- Curseurs de slider --
      const sliderHandles = findSliderHandles(instance);
      for (let s = 0; s < sliderHandles.length; s++) {
        const handleInfo = sliderHandles[s];
        const col = findMatchingColumn(handleInfo.columnName, columnLookup);
        if (!col) {
          continue;
        }
        const raw = row[col] !== undefined ? row[col].trim() : "";
        if (raw === "") {
          continue; // valeur vide -> curseur laisse a sa position par defaut
        }
        const numeric = Number(raw.replace(",", "."));
        if (isNaN(numeric)) {
          invalidSliderValues++;
          continue;
        }
        const ok = positionSliderHandle(handleInfo.node, numeric);
        if (!ok) {
          invalidSliderValues++;
        }
      }

      const col = r % columnsPerRow;
      const line = Math.floor(r / columnsPerRow);
      instance.x = originX + col * stepX;
      instance.y = originY + line * stepY;

      figma.currentPage.appendChild(instance);
      createdNodes.push(instance);
    } catch (err) {
      errorRows++;
      console.error("Erreur lors de la generation de la ligne " + r + " :", err);
    }
  }

  if (createdNodes.length > 0) {
    figma.currentPage.selection = createdNodes;
    figma.viewport.scrollAndZoomIntoView(createdNodes);
  }

  const result: GenerationResultMsg = {
    type: "generation-result",
    createdCount: createdNodes.length,
    unmatchedColumns: unmatchedColumns,
    unmatchedLayers: unmatchedLayers,
    unmatchedSliders: unmatchedSliders,
    invalidSliderValues: invalidSliderValues,
    errorRows: errorRows,
  };
  figma.ui.postMessage(result);
}

// ---- Bootstrap ----------------------------------------------------------

figma.showUI(__html__, { width: 420, height: 620 });

postSelectionInfo();
figma.on("selectionchange", postSelectionInfo);

figma.ui.onmessage = (msg: { type: string } & Record<string, unknown>) => {
  if (msg.type === "ui-ready") {
    postSelectionInfo();
    return;
  }
  if (msg.type === "generate") {
    generateFromRows(msg as unknown as GenerateMsg).catch((err) => {
      figma.ui.postMessage({
        type: "error",
        message: "Erreur inattendue : " + String(err),
      } as ErrorMsg);
    });
    return;
  }
  if (msg.type === "close") {
    figma.closePlugin();
  }
};
