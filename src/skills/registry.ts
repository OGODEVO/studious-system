import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Skill {
    id: string;
    name: string;
    description: string;
    triggers: string[];
    priority: number;
    inputs?: string[];
    outputs?: string[];
    safety_notes?: string[];
    /** Full markdown body (loaded on demand) */
    body: string;
    /** Absolute path to the SKILL.md file */
    filePath: string;
}

interface SkillFrontmatter {
    id?: string;
    name?: string;
    description?: string;
    triggers?: string[];
    priority?: number;
    inputs?: string[];
    outputs?: string[];
    safety_notes?: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SKILLS_DIR = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../../skills"
);

const REQUIRED_FIELDS: (keyof SkillFrontmatter)[] = [
    "id",
    "name",
    "description",
    "triggers",
    "priority",
];

const MATCH_THRESHOLD = 10;

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Minimal YAML-frontmatter parser.
 * Splits on the first --- ... --- block and returns
 * { frontmatter, body }.
 */
function parseFrontmatter(raw: string): {
    frontmatter: SkillFrontmatter | null;
    body: string;
} {
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!match) return { frontmatter: null, body: raw };

    try {
        const fm = yaml.load(match[1]) as SkillFrontmatter;
        return { frontmatter: fm, body: match[2].trim() };
    } catch {
        console.warn("Warning: Malformed SKILL.md frontmatter, skipping.");
        return { frontmatter: null, body: raw };
    }
}

function isValidFrontmatter(fm: SkillFrontmatter): boolean {
    return REQUIRED_FIELDS.every(
        (f) => fm[f] !== undefined && fm[f] !== null
    );
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Scan key_skills SKILL.md files, parse frontmatter, and return an
 * in-memory registry keyed by id.
 */
export function loadSkills(): Map<string, Skill> {
    const registry = new Map<string, Skill>();

    if (!fs.existsSync(SKILLS_DIR)) {
        console.warn("Warning: Skills directory not found: " + SKILLS_DIR);
        return registry;
    }

    const dirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });

    for (const entry of dirs) {
        if (!entry.isDirectory()) continue;

        const skillPath = path.join(SKILLS_DIR, entry.name, "SKILL.md");
        if (!fs.existsSync(skillPath)) continue;

        try {
            const raw = fs.readFileSync(skillPath, "utf-8");
            const { frontmatter, body } = parseFrontmatter(raw);

            if (!frontmatter || !isValidFrontmatter(frontmatter)) {
                console.warn("Warning: Skipping " + skillPath + ": missing required frontmatter fields.");
                continue;
            }

            const skill: Skill = {
                id: frontmatter.id!,
                name: frontmatter.name!,
                description: frontmatter.description!,
                triggers: frontmatter.triggers!,
                priority: frontmatter.priority!,
                inputs: frontmatter.inputs,
                outputs: frontmatter.outputs,
                safety_notes: frontmatter.safety_notes,
                body,
                filePath: skillPath,
            };

            registry.set(skill.id, skill);
        } catch (err) {
            console.warn("Warning: Failed to load skill from " + skillPath + ": " + (err as Error).message);
        }
    }

    return registry;
}

// ---------------------------------------------------------------------------
// Summary builder (for system prompt injection)
// ---------------------------------------------------------------------------

/**
 * Build a compact, one-line-per-skill summary suitable for
 * injection into the system prompt.
 */
export function buildSkillSummary(registry: Map<string, Skill>): string {
    if (registry.size === 0) return "";

    const lines = Array.from(registry.values()).map(
        (s) => "- " + s.name + " (" + s.id + "): " + s.description + " | triggers: " + s.triggers.join(", ")
    );

    return "\n## Available Skills\n" + lines.join("\n");
}

// ---------------------------------------------------------------------------
// Skill selection
// ---------------------------------------------------------------------------

/**
 * Score each skill against the user request text and pick the
 * best match above the threshold.
 *
 * Scoring rules (from SKILL.md spec):
 *   - direct trigger phrase hit:  +10  each
 *   - keyword overlap with desc:  +1   each
 *   - exact skill name mention:   +20
 *
 * Tie-break: higher priority, then alphabetical id.
 */
export function selectSkill(
    userText: string,
    registry: Map<string, Skill>
): Skill | null {
    const normalised = userText.toLowerCase().replace(/[^\w\s]/g, "");
    const words = new Set(normalised.split(/\s+/));

    let bestSkill: Skill | null = null;
    let bestScore = 0;

    for (const skill of registry.values()) {
        let score = 0;

        // Exact skill name mention -> +20
        if (normalised.includes(skill.name.toLowerCase())) {
            score += 20;
        }

        // Direct trigger phrase hit -> +10 each
        for (const trigger of skill.triggers) {
            if (normalised.includes(trigger.toLowerCase())) {
                score += 10;
            }
        }

        // Keyword overlap with description -> +1 each
        const descWords = skill.description
            .toLowerCase()
            .replace(/[^\w\s]/g, "")
            .split(/\s+/);
        for (const dw of descWords) {
            if (dw.length > 2 && words.has(dw)) {
                score += 1;
            }
        }

        if (score < MATCH_THRESHOLD) continue;

        // Tie-break: higher priority wins, then alphabetical id
        if (
            score > bestScore ||
            (score === bestScore &&
                bestSkill &&
                (skill.priority > bestSkill.priority ||
                    (skill.priority === bestSkill.priority &&
                        skill.id < bestSkill.id)))
        ) {
            bestScore = score;
            bestSkill = skill;
        }
    }

    return bestSkill;
}
