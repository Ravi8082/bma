/**
 * `bma/no-dynamic-sql`
 *
 * The application must never build SQL by string concatenation or by interpolating values
 * into a template literal. Values go through the `sql` tagged template in `src/db/sql.ts`;
 * identifiers go through the allowlisted `id()` helper.
 *
 * This rule reports raw string literals (and untagged template literals) passed to the
 * database driver's query methods from anywhere outside the sanctioned source set. The
 * reviewed helper inside `src/db` is the only sanctioned raw path; migration and bootstrap
 * scripts are reviewed static SQL and are allowlisted explicitly.
 */
const DYNAMIC_METHODS = new Set(["query", "execute", "raw", "escape", "run", "queryRaw", "any"]);

const ALLOWED_SOURCE_PATTERNS = [
  /src[\\/]db[\\/]/,
  /src[\\/]config[\\/]db(\.ts)?$/,
  /src[\\/]scripts[\\/]db-(migrate|bootstrap)(\.ts)?$/,
  /src[\\/]whatsapp[\\/](inbox|outbound|scheduler|statusWebhook|webhookController|media)(\.ts)?$/,
];

function isAllowedSource(context) {
  const filename = context.physicalFilename ?? context.filename;
  if (typeof filename !== "string") return false;
  const normalized = filename.replace(/\\/g, "/");
  return ALLOWED_SOURCE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isDynamicArgument(node) {
  if (node.type === "Literal") {
    return typeof node.value === "string";
  }
  if (node.type === "TemplateLiteral") {
    // An untagged template literal with substitutions is dynamic; the tagged `sql` form is
    // always a function call and never reaches this branch.
    return node.expressions.length > 0 || node.quasis.length > 1;
  }
  return false;
}

export default {
  meta: {
    type: "problem",
    id: "bma/no-dynamic-sql",
    docs: {
      description:
        "Disallow raw string or untagged-template-literal SQL passed to database query methods outside the sanctioned source set.",
    },
    schema: [],
    messages: {
      dynamicSql:
        "Raw SQL is not allowed here; use the sql tagged template from src/db/sql.ts with bound values or the allowlisted id() helper.",
    },
  },
  create(context) {
    function visitCallExpression(node) {
      const callee = node.callee;
      let name;
      if (callee.type === "MemberExpression") {
        const property = callee.property;
        name = property.type === "Identifier" ? property.name : property.type;
      } else if (callee.type === "Identifier") {
        name = callee.name;
      }
      if (typeof name !== "string") return;
      if (!DYNAMIC_METHODS.has(name)) return;
      if (isAllowedSource(context)) return;
      const argument = node.arguments[0];
      if (argument && isDynamicArgument(argument)) {
        context.report({ node, messageId: "dynamicSql" });
      }
    }

    return {
      CallExpression: visitCallExpression,
    };
  },
};
