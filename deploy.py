#!/usr/bin/env python3
"""Deploy fixed todo-app to NAS via SSH + base64 encoding."""

import paramiko
import base64
import os
import sys

# NAS connection details
NAS_HOST = "192.168.68.161"
NAS_USER = "maomaoxia"
NAS_PASS = "CongShaoYu102@"
NAS_DOCKER = "echo 'CongShaoYu102@' | sudo -S -p '' /usr/local/bin/docker"
REMOTE_DIR = "/volume1/projects/todo-app"

# Local files to deploy
LOCAL_BASE = "c:/Users/81537/WorkBuddy/20260425123754/todo-app"
FILES_TO_DEPLOY = [
    "server.js",
    "public/js/app.js",
    "public/index.html",
    "public/css/style.css",
]

# Dockerfile content
DOCKERFILE_CONTENT = """FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 8900
CMD ["node", "server.js"]
"""


def run_cmd(ssh, cmd, description=""):
    """Execute command on remote and return output."""
    if description:
        print(f"  >> {description}")
    stdin, stdout, stderr = ssh.exec_command(cmd)
    exit_status = stdout.channel.recv_exit_status()
    out = stdout.read().decode("utf-8", errors="replace").strip()
    err = stderr.read().decode("utf-8", errors="replace").strip()
    if out:
        for line in out.split("\n"):
            print(f"     {line}")
    if err and err != "sudo: no tty present and no askpass program specified":
        for line in err.split("\n"):
            print(f"     ERR: {line}")
    return exit_status, out, err


def deploy_file(ssh, local_path, remote_path):
    """Base64-encode a file locally and send it to NAS."""
    full_local = os.path.join(LOCAL_BASE, local_path).replace("\\", "/")
    print(f"\nDeploying {local_path} -> {remote_path}")

    # Read and base64 encode locally
    with open(full_local, "rb") as f:
        content = f.read()
    b64 = base64.b64encode(content).decode("ascii")

    # Ensure remote directory exists
    remote_dir = os.path.dirname(remote_path)
    run_cmd(ssh, f"echo '{NAS_PASS}' | sudo -S -p '' mkdir -p {remote_dir}", "Ensuring remote directory exists")

    # Write base64 to /tmp first (no sudo needed), then sudo cp to final location
    tmp_path = f"/tmp/deploy_{os.path.basename(remote_path)}"
    cmd = f"echo '{b64}' | base64 -d > {tmp_path}"
    exit_status, out, err = run_cmd(ssh, cmd, f"Writing to temp file")
    if exit_status != 0:
        print(f"  !! Failed to write temp file")
        return False

    # Copy temp file to final location with sudo
    cmd = f"echo '{NAS_PASS}' | sudo -S -p '' cp {tmp_path} {remote_path}"
    exit_status, out, err = run_cmd(ssh, cmd, f"Copying to {remote_path}")

    # Cleanup temp file
    run_cmd(ssh, f"rm -f {tmp_path}", "Cleaning up temp file")

    if exit_status != 0:
        print(f"  !! Failed to deploy {local_path}")
        return False

    # Verify file size
    exit_status, out, err = run_cmd(ssh, f"wc -c < {remote_path}", "Verifying file size")
    try:
        remote_size = int(out.strip())
        if remote_size == len(content):
            print(f"  OK: {remote_size} bytes written correctly")
            return True
        else:
            print(f"  !! Size mismatch: expected {len(content)}, got {remote_size}")
            return False
    except ValueError:
        print(f"  !! Could not verify size")
        return False


def main():
    print("=== Deploying todo-app to NAS ===\n")

    # Create SSH client
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    try:
        print("Connecting to NAS...")
        ssh.connect(NAS_HOST, username=NAS_USER, password=NAS_PASS, timeout=10)
        print("Connected.\n")

        # 1. Check if Dockerfile exists on NAS
        print("Step 1: Checking Dockerfile on NAS...")
        exit_status, out, err = run_cmd(
            ssh, f"test -f {REMOTE_DIR}/Dockerfile && echo EXISTS || echo MISSING"
        )
        if "MISSING" in out:
            print("  Dockerfile not found, creating it...")
            b64 = base64.b64encode(DOCKERFILE_CONTENT.encode()).decode("ascii")
            run_cmd(
                ssh,
                f"echo '{NAS_PASS}' | sudo -S -p '' mkdir -p {REMOTE_DIR}",
                "Ensuring remote directory exists",
            )
            run_cmd(
                ssh,
                f"echo '{b64}' | base64 -d > /tmp/deploy_Dockerfile && echo '{NAS_PASS}' | sudo -S -p '' cp /tmp/deploy_Dockerfile {REMOTE_DIR}/Dockerfile && rm -f /tmp/deploy_Dockerfile",
                "Writing Dockerfile",
            )
            print("  Dockerfile created.")
        else:
            print("  Dockerfile already exists.")

        # 2. Check if package.json exists on NAS
        print("\nStep 2: Checking package.json on NAS...")
        exit_status, out, err = run_cmd(
            ssh, f"test -f {REMOTE_DIR}/package.json && echo EXISTS || echo MISSING"
        )
        if "MISSING" in out:
            print("  package.json not found on NAS, deploying from local...")
            deploy_file(ssh, "package.json", f"{REMOTE_DIR}/package.json")
        else:
            print("  package.json exists on NAS.")

        # 3. Deploy application files
        print("\nStep 3: Deploying application files...")
        all_ok = True
        for local_file in FILES_TO_DEPLOY:
            remote_file = f"{REMOTE_DIR}/{local_file}"
            if not deploy_file(ssh, local_file, remote_file):
                all_ok = False

        if not all_ok:
            print("\n!! Some files failed to deploy. Aborting build.")
            sys.exit(1)

        # 4. Rebuild Docker container
        print("\nStep 4: Rebuilding Docker container...")
        # First stop and remove old container
        run_cmd(ssh, f"{NAS_DOCKER} stop todo-app 2>/dev/null || true", "Stopping old container")
        run_cmd(ssh, f"{NAS_DOCKER} rm todo-app 2>/dev/null || true", "Removing old container")

        # Build new image
        exit_status, out, err = run_cmd(
            ssh,
            f"cd {REMOTE_DIR} && {NAS_DOCKER} build -t todo-app .",
            "Building Docker image",
        )
        if exit_status != 0:
            print("  !! Docker build failed!")
            sys.exit(1)
        print("  Docker image built successfully.")

        # 5. Start new container
        print("\nStep 5: Starting container...")
        exit_status, out, err = run_cmd(
            ssh,
            f"{NAS_DOCKER} run -d --name todo-app --restart unless-stopped --network host -v {REMOTE_DIR}/data:/app/data todo-app",
            "Starting container with host network",
        )
        if exit_status != 0:
            # Container name might already exist
            print("  Container might already exist, trying restart...")
            run_cmd(ssh, f"{NAS_DOCKER} start todo-app", "Starting existing container")

        # 6. Health check
        print("\nStep 6: Running health check...")
        import time
        time.sleep(3)  # Give container a moment to start

        exit_status, out, err = run_cmd(
            ssh,
            f"curl -s http://localhost:8900/api/health",
            "Health check",
        )
        if "ok" in out.lower() or exit_status == 0:
            print("  Health check PASSED!")
        else:
            print(f"  Health check output: {out}")
            # Check container logs
            run_cmd(ssh, f"{NAS_DOCKER} logs todo-app --tail 20", "Container logs:")

        # 7. Verify container is running
        print("\nStep 7: Verifying container status...")
        run_cmd(ssh, f"{NAS_DOCKER} ps --filter name=todo-app --format '{{.Status}}'", "Container status")

        print("\n=== Deployment complete! ===")

    except paramiko.AuthenticationException:
        print("ERROR: Authentication failed. Check credentials.")
        sys.exit(1)
    except paramiko.SSHException as e:
        print(f"ERROR: SSH connection failed: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"ERROR: {e}")
        sys.exit(1)
    finally:
        ssh.close()


if __name__ == "__main__":
    main()
