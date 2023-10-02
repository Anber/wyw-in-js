#!/bin/bash

xml_file=".idea/wyw-in-js.iml"

# Remove all existing excludeFolder entries
xmlstarlet ed -L --delete "//content/excludeFolder" "$xml_file"

# Find folders matching the glob pattern and add them as excludeFolder entries
for folder in packages/*/{.turbo,esm,lib,types}; do
  # Check if the folder exists
  if [ -d "$folder" ]; then
    # Add the excludeFolder entry to the XML
    xmlstarlet ed -L -s "//content" -t elem -n excludeFolder -v "" -i "//excludeFolder[last()]" -t attr -n url -v "file://\$MODULE_DIR$/${folder}" "$xml_file"
    echo "Added excludeFolder entry for $folder"
  else
    echo "Folder $folder does not exist."
  fi
done
