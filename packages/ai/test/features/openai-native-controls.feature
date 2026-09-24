Feature: Native OpenAI Responses controls
  Pi keeps provider-specific Responses controls behind independent model capabilities while preserving its existing conversation, tool, and thinking-level behavior.

  Scenario: Preserve the request reasoning baseline across thinking-level changes
    Given a Responses model supports reasoning-effort updates and starts at low effort
    When the user changes Pi thinking to high and then medium
    Then each request keeps low as its reasoning effort
    And the conversation contains configuration updates for high and then medium
    And the prior input prefix remains unchanged

  Scenario: Re-establish reasoning baseline when the context changes
    Given a Responses model has a pinned request effort
    When the provider or model changes, or compaction successfully creates a new context window
    Then the next request pins its current effective effort as the new reasoning baseline
    And later thinking-level changes update the conversation without moving that baseline

  Scenario: Steer an active supported Responses response
    Given a model supports native steering over the Responses WebSocket transport
    And a response with ID "resp_active" is streaming on a WebSocket
    When the user steers the agent with "Leave auth.ts unchanged"
    Then Pi sends the steering input to "resp_active" over that same WebSocket
    And Pi follows the accepted successor response while preserving pending tool results

  Scenario: Keep queued steering for providers without native steering
    Given a provider does not support native steering
    When the user steers the agent while a response is active
    Then Pi delivers the steering message through its existing queued-steering behavior

  Scenario: Run an eligible async tool while its Responses response continues
    Given a model supports async tool calling and the "lookup" tool is eligible for async execution
    And a Responses response is streaming
    When the response completes the "lookup" call with call ID "call_original" and continues emitting events
    Then Pi starts "lookup" through its existing tool executor before the response finishes
    And the response continues streaming while "lookup" is still running
    When "lookup" finishes and the next continuation is sent
    Then Pi delivers its result using call ID "call_original"
    And the continuation refers to the latest response ID

  Scenario: Keep unsupported tools and capabilities on existing paths
    Given a tool is not eligible for async execution or a model lacks one of the Responses control capabilities
    When Pi sends tools, changes thinking, or steers during generation
    Then Pi omits unsupported protocol controls
    And synchronous tools, request-level reasoning, and queued steering retain their existing behavior
