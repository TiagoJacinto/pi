Feature: pi-gpt-6 fork CLI
  Users can run the patched fork alongside normal Pi and update it without replacing it with upstream Pi.

  Scenario: Run the fork independently of normal Pi
    Given normal Pi is installed as "pi"
    And the validated fork release is installed as "pi-gpt-6"
    When the user runs "pi-gpt-6" with CLI arguments
    Then those arguments are passed unchanged to the fork
    And the "pi" command remains unchanged

  Scenario: Update the fork and packages with --all
    Given "pi-gpt-6" is the active fork launcher
    When the user runs "pi-gpt-6 update --all"
    Then the fork is updated from upstream and its patch stack
    And installed packages are updated through Pi's package manager
    And the new fork release is activated only after build and validation succeed

  Scenario: Keep the last working release when an update conflicts or fails validation
    Given a working fork release is active
    When a fork update conflicts with a local patch or fails validation
    Then the update stops without activating the candidate release
    And the previously working release remains usable
    And conflict details and a repair prompt are saved for the user

  Scenario: Repair a patch conflict using the installed fork
    Given a fork update has stopped on a patch conflict
    When the user runs "pi-gpt-6 update --agent"
    Then the installed fork runs the resolver against the source checkout
    And the resolver does not activate or install a release
    And after successful repair the user is told to run "pi-gpt-6 update" again

  Scenario: Keep conflict repair opt-in
    Given a fork update has stopped on a patch conflict
    When the user runs "pi-gpt-6 update" or "pi-gpt-6 update --all"
    Then the update stops without invoking an agent
    And a repair prompt is written for the user
    And the installed release remains active

  Scenario: Prune old releases only after successful activation
    Given a working fork release and older releases are installed
    When a new fork release passes validation and is activated
    Then the active release and five newest previous releases are retained
    And older release directories are removed
    But build, validation, or activation failure leaves all prior releases untouched

  Scenario: Runtime update does not publish fork branches
    When the user runs "pi-gpt-6 update" or "pi-gpt-6 update --all"
    Then upstream is fetched and the local patch stack is replayed
    And neither origin/main nor origin/openai-native-controls is pushed
