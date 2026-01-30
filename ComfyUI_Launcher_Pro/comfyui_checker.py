#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ComfyUI插件&依赖自动检测修复脚本
"""
import os
import sys
import subprocess
import pkg_resources
from pathlib import Path
from datetime import datetime

def print_info(msg):
    print(f"[INFO] {msg}")

def print_warning(msg):
    print(f"[WARNING] {msg}")

def print_error(msg):
    print(f"[ERROR] {msg}")

def print_success(msg):
    print(f"[SUCCESS] {msg}")

def check_python_package(package_name):
    try:
        pkg_resources.get_distribution(package_name)
        return True
    except pkg_resources.DistributionNotFound:
        return False

def install_python_package(package_name, upgrade=False):
    try:
        cmd = [sys.executable, "-m", "pip", "install", "--upgrade" if upgrade else "", package_name]
        cmd = [c for c in cmd if c]
        print_info(f"Installing dependency: {' '.join(cmd)}")
        result = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding='utf-8'
        )
        if result.returncode == 0:
            print_success(f"Dependency installed: {package_name}")
            return True
        else:
            print_error(f"Failed to install: {package_name}")
            print_error(f"Error: {result.stderr}")
            return False
    except Exception as e:
        print_error(f"Exception installing {package_name}: {str(e)}")
        return False

def check_plugin_updates(plugin_dir):
    plugin_info = []
    if not os.path.exists(plugin_dir):
        print_warning(f"Plugin dir not exist: {plugin_dir}")
        return plugin_info
    
    for item in os.listdir(plugin_dir):
        plugin_path = os.path.join(plugin_dir, item)
        if os.path.isdir(plugin_path):
            try:
                mtime = os.path.getmtime(plugin_path)
                modify_time = datetime.fromtimestamp(mtime).strftime('%Y-%m-%d %H:%M:%S')
                days_since_update = (datetime.now() - datetime.fromtimestamp(mtime)).days
                is_recent = days_since_update <= 7
                
                plugin_info.append({
                    'name': item,
                    'path': plugin_path,
                    'modify_time': modify_time,
                    'days_since_update': days_since_update,
                    'is_recent_update': is_recent
                })
            except Exception as e:
                print_warning(f"Get plugin info failed: {item} - {str(e)}")
    
    return plugin_info

def check_plugin_requirements(plugin_dir):
    all_installed = True
    requirements_files = [
        'requirements.txt',
        'requirement.txt',
        'dependencies.txt'
    ]
    
    if not os.path.exists(plugin_dir):
        return all_installed
    
    for item in os.listdir(plugin_dir):
        plugin_path = os.path.join(plugin_dir, item)
        if os.path.isdir(plugin_path):
            req_file = None
            for rf in requirements_files:
                rf_path = os.path.join(plugin_path, rf)
                if os.path.exists(rf_path):
                    req_file = rf_path
                    break
            
            if req_file:
                print_info(f"Checking plugin dependencies: {item} ({req_file})")
                try:
                    with open(req_file, 'r', encoding='utf-8') as f:
                        lines = f.readlines()
                        for line in lines:
                            line = line.strip()
                            if not line or line.startswith('#'):
                                continue
                            
                            package = line.split('==')[0].split('>=')[0].split('<=')[0].strip()
                            if package:
                                if not check_python_package(package):
                                    print_warning(f"Missing dependency: {item} -> {package}")
                                    all_installed = False
                                    install_python_package(package)
                                else:
                                    print_success(f"Dependency installed: {item} -> {package}")
                except Exception as e:
                    print_error(f"Read requirements failed: {req_file} - {str(e)}")
    
    return all_installed

def check_comfyui_core_dependencies(comfyui_dir):
    print_info("Checking ComfyUI core dependencies...")
    
    core_deps = [
        'torch',
        'torchvision',
        'torchaudio',
        'numpy',
        'pillow',
        'tqdm',
        'psutil',
        'pyyaml',
        'requests',
        'scipy',
        'einops',
        'transformers',
        'accelerate',
        'diffusers',
        'opencv-python'
    ]
    
    all_installed = True
    for dep in core_deps:
        if not check_python_package(dep):
            print_warning(f"Missing core dependency: {dep}")
            all_installed = False
            install_python_package(dep)
        else:
            print_success(f"Core dependency installed: {dep}")
    
    return all_installed

def main(comfyui_dir):
    print_info("="*60)
    print_info("ComfyUI dependency checker started")
    print_info(f"ComfyUI dir: {comfyui_dir}")
    print_info("="*60)
    
    check_comfyui_core_dependencies(comfyui_dir)
    
    plugin_dir = os.path.join(comfyui_dir, 'custom_nodes')
    print_info(f"\nChecking plugin dir: {plugin_dir}")
    
    print_info("\nChecking plugin updates...")
    plugins = check_plugin_updates(plugin_dir)
    if plugins:
        print_info(f"Found {len(plugins)} plugins:")
        for p in plugins:
            update_status = "Recently updated" if p['is_recent_update'] else "Not updated recently"
            print_info(f"  {p['name']} - {update_status} (Last modified: {p['modify_time']})")
    else:
        print_info("No plugins found")
    
    print_info("\nChecking and fixing plugin dependencies...")
    check_plugin_requirements(plugin_dir)
    
    print_info("\n" + "="*60)
    print_success("Dependency check completed!")
    print_info("="*60)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print_error("Please specify ComfyUI directory as argument")
        sys.exit(1)
    
    comfyui_dir = sys.argv[1]
    main(comfyui_dir)
