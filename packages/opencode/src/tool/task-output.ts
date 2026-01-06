import { Tool } from "./tool"
import z from "zod"
import { Session } from "../session"
import { MessageV2 } from "../session/message-v2"
import { SessionStatus } from "../session/status"

export const TaskOutputTool = Tool.define("task_output", async () => {
  return {
    description: `Retrieves output from a running or completed background task.

Usage:
- Takes a session_id parameter identifying the background task
- Returns the task output along with status information
- Use block=true (default) to wait for task completion
- Use block=false for non-blocking check of current status

Example:
  task_output({ session_id: "session_xxx", block: false })
`,
    parameters: z.object({
      session_id: z.string().describe("The session ID of the background task"),
      block: z.boolean().describe("Whether to wait for completion (default: true)").optional(),
      timeout: z.number().describe("Max wait time in ms (default: 30000)").optional(),
    }),
    async execute(params, ctx) {
      const sessionId = params.session_id
      const shouldBlock = params.block !== false
      const timeout = params.timeout ?? 30000

      const session = await Session.get(sessionId).catch(() => null)
      if (!session) {
        return {
          title: "Task not found",
          metadata: { sessionId, status: "not_found" },
          output: `Task with session_id "${sessionId}" not found.`,
        }
      }

      const status = SessionStatus.get(sessionId)

      // If not blocking, return current status immediately
      if (!shouldBlock) {
        const messages = await Session.messages({ sessionID: sessionId })
        const lastAssistant = messages.findLast((m) => m.info.role === "assistant")

        return {
          title: session.title,
          metadata: {
            sessionId,
            status: status.type,
          },
          output: formatOutput(session, status, lastAssistant),
        }
      }

      // Block and wait for completion
      const startTime = Date.now()
      while (Date.now() - startTime < timeout) {
        const currentStatus = SessionStatus.get(sessionId)
        if (currentStatus.type === "idle") {
          // Task completed
          const messages = await Session.messages({ sessionID: sessionId })
          const lastAssistant = messages.findLast((m) => m.info.role === "assistant")

          return {
            title: session.title,
            metadata: {
              sessionId,
              status: "completed",
            },
            output: formatOutput(session, currentStatus, lastAssistant),
          }
        }
        // Wait a bit before checking again
        await new Promise((resolve) => setTimeout(resolve, 500))
      }

      // Timeout reached
      const messages = await Session.messages({ sessionID: sessionId })
      const lastAssistant = messages.findLast((m) => m.info.role === "assistant")

      return {
        title: session.title,
        metadata: {
          sessionId,
          status: "timeout",
        },
        output: `Task timed out after ${timeout}ms.\n\n` + formatOutput(session, status, lastAssistant),
      }
    },
  }
})

function formatOutput(
  session: Session.Info,
  status: ReturnType<typeof SessionStatus.get>,
  lastAssistant?: MessageV2.WithParts
): string {
  const lines: string[] = []

  lines.push(`Session: ${session.id}`)
  lines.push(`Title: ${session.title}`)
  lines.push(`Status: ${status.type}`)

  if (lastAssistant) {
    const textPart = lastAssistant.parts.findLast((p) => p.type === "text")
    if (textPart && textPart.type === "text") {
      lines.push("")
      lines.push("Output:")
      lines.push(textPart.text)
    }

    const toolParts = lastAssistant.parts.filter((p) => p.type === "tool") as MessageV2.ToolPart[]
    if (toolParts.length > 0) {
      lines.push("")
      lines.push("Tool calls:")
      for (const part of toolParts) {
        const title = "title" in part.state ? part.state.title : undefined
        lines.push(`  - ${part.tool}: ${part.state.status}${title ? ` (${title})` : ""}`)
      }
    }
  }

  return lines.join("\n")
}
