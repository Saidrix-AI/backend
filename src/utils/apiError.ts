export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    /**
     * A stable machine-readable tag for the cases a client has to branch on,
     * rather than matching the message text. Only set where that matters —
     * `subscription_required` is what tells the browser to route to the plans
     * page instead of showing the error.
     */
    public readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
