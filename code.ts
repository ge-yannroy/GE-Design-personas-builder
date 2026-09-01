// ============================================================================
// GE-DESIGN Personas Builder
// Genere une instance de composant/frame par ligne de CSV, en remplissant
// automatiquement les calques texte dont le nom correspond a une colonne.
// ============================================================================

// ---- Types de messages UI <-> main ----------------------------------------

interface SelectionInfoMsg {
  type: "selection-info";
  valid: boolean;
  reason?: string;
  templateName?: string;
  templateType?: string;
  textLayerNames?: string[];
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
  errorRows: number;
}

interface ErrorMsg {
  type: "error";
  message: string;
}

type TemplateNode = ComponentNode | InstanceNode | FrameNode | GroupNode | ComponentSetNode;

// ---- Etat --------------------------------------------------------------

let currentTemplate: TemplateNode | null = null;
let currentTextLayerNames: string[] = [];

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

/** Charge toutes les polices utilisees par un noeud texte (gere les polices mixtes). */
async function loadFontsForTextNode(node: TextNode): Promise<void> {
  const len = node.characters.length;

  if (node.fontName !== figma.mixed) {
    await figma.loadFontAsync(node.fontName as FontName);
    return;
  }

  if (len === 0) {
    // Rien a lire dans une chaine vide : on retombe sur la police par defaut du noeud.
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

/** Recherche insensible a la casse d'une colonne correspondant au nom de calque. */
function findMatchingColumn(
  layerName: string,
  columnLookup: Map<string, string>
): string | undefined {
  return columnLookup.get(layerName.trim().toLowerCase());
}

/** Duplique le gabarit : createInstance() pour un COMPONENT, clone() sinon. */
function duplicateTemplate(template: TemplateNode): FrameNode | GroupNode | ComponentNode | InstanceNode {
  if (template.type === "COMPONENT") {
    return template.createInstance();
  }
  if (template.type === "COMPONENT_SET") {
    // Un component set n'est pas instanciable directement : on utilise sa
    // premiere variante comme gabarit effectif.
    const firstVariant = template.children[0] as ComponentNode;
    return firstVariant.createInstance();
  }
  // FRAME, GROUP, INSTANCE : on clone.
  return template.clone() as FrameNode | GroupNode | InstanceNode;
}

// ---- Analyse de la selection ----------------------------------------------

function analyzeSelection(): SelectionInfoMsg {
  const selection = figma.currentPage.selection;

  if (selection.length !== 1) {
    currentTemplate = null;
    currentTextLayerNames = [];
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
  const textNodes = findTextNodes(
    template.type === "COMPONENT_SET" ? template.children[0] : template
  );

  if (textNodes.length === 0) {
    currentTemplate = null;
    currentTextLayerNames = [];
    return {
      type: "selection-info",
      valid: false,
      reason: "Aucun calque texte trouve dans ce gabarit.",
    };
  }

  currentTemplate = template;
  currentTextLayerNames = textNodes.map((t) => t.name);

  return {
    type: "selection-info",
    valid: true,
    templateName: template.name,
    templateType: template.type,
    textLayerNames: currentTextLayerNames,
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

  // Table de correspondance colonne (minuscule) -> nom original de colonne.
  const columnLookup = new Map<string, string>();
  for (let i = 0; i < headers.length; i++) {
    columnLookup.set(headers[i].trim().toLowerCase(), headers[i]);
  }

  // Determine, une bonne fois, quelles colonnes / calques ne matchent rien.
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
  const unmatchedColumns = headers.filter((h) => !matchedColumns.has(h));
  const uniqueLayerNames = Array.from(new Set(currentTextLayerNames));
  const unmatchedLayers = uniqueLayerNames.filter((l) => !matchedLayers.has(l));

  if (matchedColumns.size === 0) {
    figma.ui.postMessage({
      type: "error",
      message:
        "Aucune colonne du CSV ne correspond a un nom de calque texte du gabarit. Verifiez l'orthographe des colonnes / calques.",
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

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    try {
      const instance = duplicateTemplate(template);
      const textNodes = findTextNodes(instance);

      for (let t = 0; t < textNodes.length; t++) {
        const textNode = textNodes[t];
        const col = findMatchingColumn(textNode.name, columnLookup);
        if (!col) {
          // Pas de correspondance : on garde le contenu par defaut du gabarit.
          continue;
        }
        const value = row[col] !== undefined ? row[col] : "";
        await loadFontsForTextNode(textNode);
        // Colonne vide -> calque texte vide (plutot que de planter).
        textNode.characters = value;
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
    errorRows: errorRows,
  };
  figma.ui.postMessage(result);
}

// ---- Bootstrap ----------------------------------------------------------

figma.showUI(__html__, { width: 420, height: 560 });

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
