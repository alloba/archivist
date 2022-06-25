# Archivist

Scan sources for media and save results. 

Targetted sources will be scanned for all available files, and results will be compared 
with the destination specified during initialization. Anything that does not already exist in 
the destination will be pulled from the source. 

Sources and destinations rely on generic interfaces, so the specific mechanism can vary 
for both the uniqueness check and the download. 
However, the primary use case for this project is to interface with 4Chan boards, to save to 
either a local directory or a S3 bucket. 
So generally expect examples to align with those items. 

## Usage 

This program is run via Node. 
It can be provided both a config file and runtime parameters, 
with the latter overwriting values in the former.  

Values provided to the script will determine source, destination, and 
criteria used when searching for media. 

### Examples 

**Run with config file**   
`npm run start --config config.json`

**Run with config file and overriding parameters**  
`npm run start --config config.json --destination.type s3 --source.params.requestDelay 1500`

## Configuration

All parameters listed in this section can be provided either inside the configuration file 
as a json object, or as runtime parameters.
The naming should be identical between the two options, with runtime parameters overriding 
any conflicting value that also exists in a provided config file. 

### Generic Configuration
| Param            | Description                                                                                                                                                               | Supported Values      | 
|------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----------------------|
| source.type      | Type of source that is being pulled from. This will determine the specific module that is used to interface with the source                                               | `4chan`, `directory`  |
| source.path      | The path inside of the source used to search for files. This has different meaning depending on the source. Refer to individual source documentation for more information | `wsg`, `subdirectory` |
| source.params    | Source-specific override values. These are source specific. Refer to individual source docs for more information                                                          | `timeout`, `delay`    |
|                  |                                                                                                                                                                           |                       |
| destination.type | The desired destination type. The place that downloaded files will be placed.                                                                                             | `s3`, `directory`     |
| destination.path | The path inside of the destination that will be used for storage. This can have different meaning depending on the destination. Refer to specific destination docs.       | `/folder/path`        |

### Sources

#### 4Chan 

The OG. Specifying 4Chan as a source will cause this program to reach out to the site when looking for media files. 
This source relies on basic interaction with the api that is provided by the site to pull individual threads and 
their contents. 

**Source Configuration** 

| Param               | Description                                                                                                                                                                                      | Example Values          |
|---------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-------------------------|
| source.board        | Which board to use as a source for the media scan                                                                                                                                                | `wsg`, `gif`            |
| source.searchTerm   | A search string to use when looking for threads to pull media from. This would be a substring of the thread title, case-insensitive.                                                             | `ygyl`, `ylyl`, `comfy` |
| source.requestDelay | The amount of time in milliseconds between interactions with the 4Chan api. The site requests at least a 1 second pause between operations. This parameter is not allowed to be lower than that. | `1000`, `5000`          |

#### Directory

Uses a file system directory as a source. 
This is primarily for testing purposes, but could also be used for a network mount or something similar. 

**Source Params** 

*N/A*. This basic use-case is entirely covered by the generic params described above. Source path is all that is needed. 
There are no additional source params. 
