#!/bin/bash
# ==============================================================================
# Script Name: update_source.sh
# Description: Automates pull and restart service from primary repository.
# ==============================================================================

if [ $# -lt 1 ]; then
    echo "Usage: $0 <service_name>"
    exit 1
fi

SERVICE_NAME=$1

if [ "$SERVICE_NAME" = "orchestrator" ] || [ "$SERVICE_NAME" = "supervisor" ]; then
    echo {"Service is set to $SERVICE_NAME."}
else
    echo "Unknown service name: $SERVICE_NAME. Please specify either 'orchestrator' or 'supervisor'."
    exit 1
fi

echo "=== Starting script execution ==="

# # 1. Navigate to the repository directory
# REPO_DIR="/opt/mycelium"
# if [ -d "$REPO_DIR" ]; then
#     cd "$REPO_DIR" || { echo "Failed to navigate to $REPO_DIR"; exit 1; }
# else
#     echo "Repository directory $REPO_DIR does not exist. Exiting."
#     exit 1
# fi

# 2. Pull the latest changes from the repository
echo "Pulling latest changes from the repository..."
if git pull origin main; then
    echo "Successfully pulled latest changes."
else
    echo "Failed to pull latest changes. Exiting."
    exit 1
fi

# 3. pnpm install to update dependencies
echo "Installing dependencies using pnpm..."
if pnpm install --frozen-lockfile; then
    echo "Dependencies installed successfully."
else
    echo "Failed to install dependencies. Exiting."
    exit 1
fi

# 4. Build the project
echo "Building the project..."
if pnpm build; then
    echo "Project built successfully."
else
    echo "Failed to build the project. Exiting."
    exit 1
fi

# 5. Restart the service
echo "Restarting the service..."
if sudo systemctl restart mycelium-"$SERVICE_NAME"; then
    echo "Service restarted successfully."
else
    echo "Failed to restart the service. Exiting."
    exit 1
fi