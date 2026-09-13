// The inline MCP resource tools are added to the tool set by SessionTools but
// are not registry tools, so their permission key cannot come from tool
// metadata. They all ask the "read" permission (see their definitions in
// tools.ts), so their ids and key are declared here — a leaf module that both
// tools.ts and the request prep can import without a cycle — for the permission
// machinery to resolve them to the "read" group.
export const MCP_RESOURCE_TOOLS = {
  list: "list_mcp_resources",
  listTemplates: "list_mcp_resource_templates",
  read: "read_mcp_resource",
} as const

export const MCP_RESOURCE_PERMISSION_KEY = "read"

export function isMcpResourceTool(id: string): boolean {
  return id === MCP_RESOURCE_TOOLS.list || id === MCP_RESOURCE_TOOLS.listTemplates || id === MCP_RESOURCE_TOOLS.read
}
